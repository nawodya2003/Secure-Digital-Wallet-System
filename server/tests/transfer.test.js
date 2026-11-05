const path = require("node:path");
require("dotenv").config({
  path: path.join(__dirname, "../.env.test"),
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const {
  createDemoWallet,
  fundDemoWallet,
  transferMoney,
  getWalletBalance,
} = require("../src/services/walletService");

if (
  !process.env.TEST_DATABASE_URL ||
  !process.env.TEST_DATABASE_URL.includes(
    "/securepay_test_db"
  )
) {
  throw new Error(
    "Tests require the dedicated securepay_test_db"
  );
}

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 10,
});

async function wallet() {
  return createDemoWallet(
    pool,
    `test-${randomUUID()}@example.test`,
    "Automated Test User"
  );
}

async function fund(walletId, cents) {
  return fundDemoWallet(pool, {
    walletId,
    amountCents: cents,
    idempotencyKey: randomUUID(),
  });
}

function makeTransfer(senderId, receiverId, cents, key) {
  return transferMoney(pool, {
    senderWalletId: senderId,
    receiverWalletId: receiverId,
    amountCents: cents,
    idempotencyKey: key,
  });
}

test("01 - Demo funding is balanced", async () => {
  const user = await wallet();

  const funding = await fund(user.walletId, "100000");

  assert.equal(funding.status, "completed");

  assert.equal(
    await getWalletBalance(pool, user.walletId),
    "100000"
  );

  const result = await pool.query(
    `SELECT COUNT(*)::int AS count,
            SUM(amount_cents)::text AS total
     FROM ledger_entries
     WHERE funding_id = $1`,
    [funding.fundingId]
  );

  assert.equal(result.rows[0].count, 2);
  assert.equal(result.rows[0].total, "0");
});

test("02 - Valid transfer updates balances", async () => {
  const a = await wallet();
  const b = await wallet();

  await fund(a.walletId, "1000000");
  await fund(b.walletId, "200000");

  const result = await makeTransfer(
    a.walletId,
    b.walletId,
    "300000",
    randomUUID()
  );

  assert.equal(result.status, "completed");

  assert.equal(
    await getWalletBalance(pool, a.walletId),
    "700000"
  );

  assert.equal(
    await getWalletBalance(pool, b.walletId),
    "500000"
  );

  const entries = await pool.query(
    `SELECT COUNT(*)::int AS count,
            SUM(amount_cents)::text AS total
     FROM ledger_entries
     WHERE transfer_id = $1`,
    [result.transferId]
  );

  assert.equal(entries.rows[0].count, 2);
  assert.equal(entries.rows[0].total, "0");
});

test("03 - Insufficient funds cause rollback", async () => {
  const a = await wallet();
  const b = await wallet();

  await fund(a.walletId, "50000");

  const key = randomUUID();

  await assert.rejects(
    makeTransfer(
      a.walletId,
      b.walletId,
      "100000",
      key
    ),
    (error) => error.code === "INSUFFICIENT_FUNDS"
  );

  assert.equal(
    await getWalletBalance(pool, a.walletId),
    "50000"
  );

  assert.equal(
    await getWalletBalance(pool, b.walletId),
    "0"
  );

  const rows = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM transfers
     WHERE sender_wallet_id = $1
       AND idempotency_key = $2`,
    [a.walletId, key]
  );

  assert.equal(rows.rows[0].count, 0);
});

test("04 - Duplicate request returns same transaction", async () => {
  const a = await wallet();
  const b = await wallet();

  await fund(a.walletId, "100000");

  const key = randomUUID();

  const first = await makeTransfer(
    a.walletId, b.walletId, "30000", key
  );

  const second = await makeTransfer(
    a.walletId, b.walletId, "30000", key
  );

  assert.equal(first.transferId, second.transferId);
  assert.equal(second.replayed, true);

  assert.equal(
    await getWalletBalance(pool, a.walletId),
    "70000"
  );

  assert.equal(
    await getWalletBalance(pool, b.walletId),
    "30000"
  );
});

test("05 - Different request with same key is rejected", async () => {
  const a = await wallet();
  const b = await wallet();

  await fund(a.walletId, "100000");

  const key = randomUUID();

  await makeTransfer(
    a.walletId, b.walletId, "20000", key
  );

  await assert.rejects(
    makeTransfer(
      a.walletId, b.walletId, "40000", key
    ),
    (error) => error.code === "IDEMPOTENCY_CONFLICT"
  );

  assert.equal(
    await getWalletBalance(pool, a.walletId),
    "80000"
  );
});

test("06 - Parallel transfers cannot double spend", async () => {
  const a = await wallet();
  const b = await wallet();
  const c = await wallet();

  // Sender starts with Rs. 100
  await fund(a.walletId, "10000");

  // Two simultaneous transfers of Rs. 70 each
  const results = await Promise.allSettled([
    makeTransfer(
      a.walletId, b.walletId,
      "7000", randomUUID()
    ),
    makeTransfer(
      a.walletId, c.walletId,
      "7000", randomUUID()
    ),
  ]);

  const successful = results.filter(
    r => r.status === "fulfilled"
  );

  const rejected = results.filter(
    r => r.status === "rejected"
  );

  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);

  assert.equal(
    rejected[0].reason.code,
    "INSUFFICIENT_FUNDS"
  );

  const senderBalance = BigInt(
    await getWalletBalance(pool, a.walletId)
  );

  const bBalance = BigInt(
    await getWalletBalance(pool, b.walletId)
  );

  const cBalance = BigInt(
    await getWalletBalance(pool, c.walletId)
  );

  assert.equal(senderBalance, 3000n);
  assert.equal(bBalance + cBalance, 7000n);
});

test.after(async () => {
  await pool.end();
});
