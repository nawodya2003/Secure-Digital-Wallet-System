const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env.test") });

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const request = require("supertest");

if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("/securepay_test_db")) {
  throw new Error("Dedicated securepay_test_db is required");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

const app = require("../src/app");
const { pool } = require("../src/db");
const { fundDemoWallet, getWalletBalance } = require("../src/services/walletService");
const ORIGIN = "http://localhost:5173";
const password = "SecurePayTestPassword_2026!";

function post(agent, endpoint, body, csrfToken) {
  let req = agent.post(endpoint).set("Origin", ORIGIN).send(body);
  if (csrfToken) req = req.set("x-csrf-token", csrfToken);
  return req;
}
async function register(agent, name) {
  const email = `user-${randomUUID()}@example.test`;
  const res = await post(agent, "/api/auth/register", { fullName: name, email, password });
  assert.equal(res.status, 201);
  return { ...res.body, email };
}

test("SecurePay authentication and authorization", async (t) => {
  const amalAgent = request.agent(app);
  const nimalAgent = request.agent(app);
  let amal; let nimal; let amalWallet; let nimalWallet;
  await t.test("01 - Registration creates two users", async () => { amal = await register(amalAgent, "Amal"); nimal = await register(nimalAgent, "Nimal"); assert.equal(amal.user.role, "user"); assert.equal(nimal.user.role, "user"); });
  await t.test("02 - Password stored as Argon2id hash", async () => { const r = await pool.query("SELECT password_hash FROM user_credentials WHERE user_id = $1", [amal.user.id]); assert.equal(r.rowCount, 1); assert.ok(r.rows[0].password_hash.startsWith("$argon2id$")); });
  await t.test("03 - Guest cannot access private wallet", async () => assert.equal((await request(app).get("/api/wallet/me")).status, 401));
  await t.test("04 - Invalid password is rejected", async () => assert.equal((await post(request(app), "/api/auth/login", { email: amal.email, password: "WrongPassword_123456" })).status, 401));
  await t.test("05 - Session identifies correct user", async () => { const r = await amalAgent.get("/api/auth/me"); assert.equal(r.status, 200); assert.equal(r.body.user.id, amal.user.id); });
  await t.test("06 - CSRF is required for transfers", async () => assert.equal((await post(amalAgent, "/api/wallet/transfer", { receiverWalletId: randomUUID(), amountCents: "1000", idempotencyKey: randomUUID() })).status, 403));
  await t.test("07 - Cross-origin request is rejected", async () => assert.equal((await amalAgent.post("/api/auth/logout").set("Origin", "https://attacker.example").set("x-csrf-token", amal.csrfToken).send({})).status, 403));
  await t.test("08 - Users cannot access admin endpoint", async () => assert.equal((await amalAgent.get("/api/admin/check")).status, 403));
  await t.test("09 - Wallet ownership is enforced", async () => { const a = await amalAgent.get("/api/wallet/me"); const b = await nimalAgent.get("/api/wallet/me"); assert.equal(a.status, 200); assert.equal(b.status, 200); amalWallet = a.body.walletId; nimalWallet = b.body.walletId; assert.notEqual(amalWallet, nimalWallet); });
  await t.test("10 - Authorized demo transfer succeeds", async () => { await fundDemoWallet(pool, { walletId: amalWallet, amountCents: "100000", idempotencyKey: randomUUID() }); const key = randomUUID(); const first = await post(amalAgent, "/api/wallet/transfer", { receiverWalletId: nimalWallet, amountCents: "30000", idempotencyKey: key }, amal.csrfToken); assert.equal(first.status, 200); const retry = await post(amalAgent, "/api/wallet/transfer", { receiverWalletId: nimalWallet, amountCents: "30000", idempotencyKey: key }, amal.csrfToken); assert.equal(retry.body.replayed, true); assert.equal(await getWalletBalance(pool, amalWallet), "70000"); });
  await t.test("11 - Logout revokes the session", async () => { assert.equal((await post(amalAgent, "/api/auth/logout", {}, amal.csrfToken)).status, 200); assert.equal((await amalAgent.get("/api/auth/me")).status, 401); });
  await t.test("12 - Login creates a fresh session", async () => { const r = await post(amalAgent, "/api/auth/login", { email: amal.email, password }); assert.equal(r.status, 200); assert.ok(r.body.csrfToken); });
});
test.after(async () => { await pool.end(); });
