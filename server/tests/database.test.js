require("dotenv").config();

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db");

async function createTestWallet(client) {
  const email = `test-${randomUUID()}@example.test`;

  const userResult = await client.query(
    `INSERT INTO users (email, full_name)
     VALUES ($1, $2)
     RETURNING id`,
    [email, "Test User"]
  );

  const walletResult = await client.query(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     RETURNING id`,
    [userResult.rows[0].id]
  );

  return walletResult.rows[0].id;
}

// Test 1: Required tables exist
test("Financial tables exist", async () => {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
  `);

  const tables = result.rows.map(row => row.table_name);

  for (const name of [
    "users",
    "wallets",
    "ledger_accounts",
    "transfers",
    "ledger_entries",
    "audit_events"
  ]) {
    assert.ok(tables.includes(name));
  }
});

// Test 2: Negative transfers must be rejected
test("Negative transfer amount is rejected", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const senderId = await createTestWallet(client);
    const receiverId = await createTestWallet(client);

    await assert.rejects(
      client.query(
        `INSERT INTO transfers (
          sender_wallet_id,
          receiver_wallet_id,
          amount_cents,
          idempotency_key
        )
        VALUES ($1, $2, $3, $4)`,
        [senderId, receiverId, -500, randomUUID()]
      ),
      (error) => error.code === "23514"
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

// Test 3: Completed transfers require ledger entries
test("Incomplete ledger cannot be completed", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const senderId = await createTestWallet(client);
    const receiverId = await createTestWallet(client);

    const result = await client.query(
      `INSERT INTO transfers (
        sender_wallet_id,
        receiver_wallet_id,
        amount_cents,
        idempotency_key
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id`,
      [senderId, receiverId, 300000, randomUUID()]
    );

    const transferId = result.rows[0].id;

    await client.query(
      `UPDATE transfers
       SET status = 'completed'
       WHERE id = $1`,
      [transferId]
    );

    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error) => error.code === "23514"
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

// Close the connection pool after tests
test.after(async () => {
  await pool.end();
});
