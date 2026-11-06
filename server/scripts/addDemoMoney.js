require("dotenv").config();
const { randomUUID } = require("node:crypto");
const { pool } = require("../src/db");
const { fundDemoWallet, getWalletBalance } = require("../src/services/walletService");

async function main() {
  const walletId = process.argv[2];
  const amountCents = process.argv[3];
  if (!walletId || !amountCents) {
    console.error("Usage: node scripts/addDemoMoney.js WALLET_ID AMOUNT_CENTS");
    process.exitCode = 1;
    return;
  }
  const result = await fundDemoWallet(pool, { walletId, amountCents, idempotencyKey: randomUUID() });
  console.log("Demo funding:", result);
  const balance = await getWalletBalance(pool, walletId);
  console.log("New balance: LKR", (BigInt(balance) / 100n).toString(), ".", (BigInt(balance) % 100n).toString().padStart(2, "0"));
}

main().catch((error) => {
  console.error(error.code || "ERROR", error.message);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
