

require("dotenv").config();

const { randomUUID } = require("node:crypto");
const { pool } = require("../src/db");

const {
  createDemoWallet,
  fundDemoWallet,
  transferMoney,
  getWalletBalance,
} = require("../src/services/walletService");

function showBalance(label, cents) {
  const amount = BigInt(cents);

  const rupees = amount / 100n;
  const fraction = (amount % 100n)
    .toString()
    .padStart(2, "0");

  console.log(`${label}: Rs. ${rupees}.${fraction}`);
}

async function main() {
  const suffix = randomUUID().slice(0, 8);

  const userA = await createDemoWallet(
    pool,
    `amal-${suffix}@example.test`,
    "Amal"
  );

  const userB = await createDemoWallet(
    pool,
    `nimal-${suffix}@example.test`,
    "Nimal"
  );

  console.log("Demo wallets created");

  // Fund Rs. 10,000
  await fundDemoWallet(pool, {
    walletId: userA.walletId,
    amountCents: "1000000",
    idempotencyKey: randomUUID(),
  });

  // Fund Rs. 2,000
  await fundDemoWallet(pool, {
    walletId: userB.walletId,
    amountCents: "200000",
    idempotencyKey: randomUUID(),
  });

  console.log("\nBEFORE TRANSFER");

  showBalance(
    "Amal",
    await getWalletBalance(pool, userA.walletId)
  );

  showBalance(
    "Nimal",
    await getWalletBalance(pool, userB.walletId)
  );

  const key = randomUUID();

  // Transfer Rs. 3,000
  const result = await transferMoney(pool, {
    senderWalletId: userA.walletId,
    receiverWalletId: userB.walletId,
    amountCents: "300000",
    idempotencyKey: key,
  });

  console.log("\nTransaction:", result);

  console.log("\nAFTER TRANSFER");

  showBalance(
    "Amal",
    await getWalletBalance(pool, userA.walletId)
  );

  showBalance(
    "Nimal",
    await getWalletBalance(pool, userB.walletId)
  );

  // Retry same transaction
  const retry = await transferMoney(pool, {
    senderWalletId: userA.walletId,
    receiverWalletId: userB.walletId,
    amountCents: "300000",
    idempotencyKey: key,
  });

  console.log("\nIdempotent retry:", retry);
}

main()
  .catch((error) => {
    console.error(error.code || "ERROR", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
