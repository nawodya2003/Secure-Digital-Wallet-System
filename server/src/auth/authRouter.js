const express = require("express");
const argon2 = require("argon2");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");

const { transferMoney, getWalletBalance, withTransaction } = require("../services/walletService");
const { COOKIE_NAME, hashToken, generateToken, cookieOptions, requireAuth, requireCsrf, requireRole } = require("./requireAuth");

const registerSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(150),
  email: z.email().max(255),
  password: z.string().min(12).max(128),
});
const loginSchema = z.strictObject({ email: z.email().max(255), password: z.string().min(1) });
const transferSchema = z.strictObject({
  receiverWalletId: z.uuid(),
  amountCents: z.string().regex(/^[1-9][0-9]*$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const argonOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

function createAuthRouter(pool) {
  const router = express.Router();
  const authenticate = requireAuth(pool);

  router.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const origin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
    if (req.get("origin") !== origin) return res.status(403).json({ message: "Origin not allowed" });
    if (!req.is("application/json")) return res.status(415).json({ message: "JSON content type required" });
    next();
  });

  async function issueSession(client, userId) {
    const token = generateToken();
    const csrfToken = generateToken();
    await client.query(`INSERT INTO user_sessions(user_id, token_hash, csrf_hash, expires_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`, [userId, hashToken(token), hashToken(csrfToken)]);
    return { token, csrfToken };
  }
  function setSessionCookie(res, token) { res.cookie(COOKIE_NAME, token, cookieOptions()); }

  router.post("/auth/register", authLimiter, async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid registration details" });
    const { fullName, password } = parsed.data;
    const email = parsed.data.email.trim().toLowerCase();
    try {
      const passwordHash = await argon2.hash(password, argonOptions);
      const result = await withTransaction(pool, async (client) => {
        const userResult = await client.query(`INSERT INTO users(email, full_name, role)
          VALUES ($1, $2, 'user') RETURNING id, email, full_name, role`, [email, fullName]);
        const user = userResult.rows[0];
        await client.query(`INSERT INTO user_credentials(user_id, password_hash) VALUES ($1, $2)`, [user.id, passwordHash]);
        const wallet = await client.query(`INSERT INTO wallets(user_id) VALUES ($1) RETURNING id`, [user.id]);
        await client.query(`INSERT INTO ledger_accounts(wallet_id, account_type, currency) VALUES ($1, 'wallet', 'LKR')`, [wallet.rows[0].id]);
        const session = await issueSession(client, user.id);
        await client.query(`INSERT INTO audit_events(actor_user_id, event_type, entity_type, entity_id)
          VALUES ($1, 'USER_REGISTERED', 'user', $1)`, [user.id]);
        return { user, session };
      });
      setSessionCookie(res, result.session.token);
      return res.status(201).json({ user: result.user, csrfToken: result.session.csrfToken });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ message: "Unable to register with this email" });
      next(error);
    }
  });

  router.post("/auth/login", authLimiter, async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid login details" });
    const email = parsed.data.email.trim().toLowerCase();
    try {
      const result = await pool.query(`SELECT u.id, u.email, u.full_name, u.role, c.password_hash
        FROM users u JOIN user_credentials c ON c.user_id = u.id
        WHERE u.email = $1 AND u.status = 'active'`, [email]);
      const user = result.rows[0];
      if (!user || !(await argon2.verify(user.password_hash, parsed.data.password))) return res.status(401).json({ message: "Invalid email or password" });
      const session = await withTransaction(pool, async (client) => {
        const created = await issueSession(client, user.id);
        await client.query(`INSERT INTO audit_events(actor_user_id, event_type, entity_type, entity_id)
          VALUES ($1, 'USER_LOGIN', 'user', $1)`, [user.id]);
        return created;
      });
      setSessionCookie(res, session.token);
      return res.json({ user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }, csrfToken: session.csrfToken });
    } catch (error) { next(error); }
  });

  router.get("/auth/me", authenticate, (req, res) => res.json({ user: { id: req.auth.user_id, email: req.auth.email, full_name: req.auth.full_name, role: req.auth.role } }));
  router.get("/auth/csrf", authenticate, async (req, res, next) => {
    try { const csrfToken = generateToken(); await pool.query("UPDATE user_sessions SET csrf_hash = $1 WHERE id = $2", [hashToken(csrfToken), req.auth.session_id]); res.set("Cache-Control", "no-store"); res.json({ csrfToken }); } catch (error) { next(error); }
  });
  router.post("/auth/logout", authenticate, requireCsrf, async (req, res, next) => {
    try { await pool.query("UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1", [req.auth.session_id]); res.clearCookie(COOKIE_NAME, cookieOptions()); res.json({ message: "Logged out successfully" }); } catch (error) { next(error); }
  });
  router.get("/wallet/me", authenticate, async (req, res, next) => {
    try { const result = await pool.query("SELECT id, currency, status FROM wallets WHERE user_id = $1 AND currency = 'LKR'", [req.auth.user_id]); if (result.rowCount !== 1) return res.status(404).json({ message: "Wallet not found" }); const wallet = result.rows[0]; const balance = await getWalletBalance(pool, wallet.id); res.set("Cache-Control", "no-store"); res.json({ walletId: wallet.id, currency: wallet.currency, status: wallet.status, balanceCents: balance }); } catch (error) { next(error); }
  });
  router.post("/wallet/transfer", authenticate, requireCsrf, async (req, res, next) => {
    if (!["development", "test"].includes(process.env.NODE_ENV)) return res.status(403).json({ message: "Demo transfer API disabled" });
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid transfer details" });
    try { const ownWallet = await pool.query("SELECT id FROM wallets WHERE user_id = $1 AND currency = 'LKR'", [req.auth.user_id]); if (ownWallet.rowCount !== 1) return res.status(403).json({ message: "Wallet access denied" }); const data = await transferMoney(pool, { senderWalletId: ownWallet.rows[0].id, ...parsed.data }); res.json(data); } catch (error) { const codes = { INSUFFICIENT_FUNDS: 409, IDEMPOTENCY_CONFLICT: 409, WALLET_BLOCKED: 403, WALLET_NOT_FOUND: 404, SAME_WALLET: 400, INVALID_AMOUNT: 400, LIMIT_EXCEEDED: 400 }; if (codes[error.code]) return res.status(codes[error.code]).json({ message: error.message }); next(error); }
  });
  router.get("/admin/check", authenticate, requireRole("admin"), (req, res) => res.json({ authorized: true }));
  return router;
}
module.exports = createAuthRouter;
