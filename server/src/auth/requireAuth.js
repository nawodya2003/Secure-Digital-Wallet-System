const crypto = require("node:crypto");

const COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Host-securepay_sid"
    : "securepay_sid";

function hashToken(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  };
}

function requireAuth(pool) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];

      if (
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(token)
      ) {
        return res.status(401).json({
          message: "Authentication required",
        });
      }

      const result = await pool.query(
        `SELECT
           s.id AS session_id,
           s.csrf_hash,
           u.id AS user_id,
           u.email,
           u.full_name,
           u.role
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > NOW()
           AND u.status = 'active'`,
        [hashToken(token)]
      );

      if (result.rowCount !== 1) {
        return res.status(401).json({
          message: "Invalid or expired session",
        });
      }

      req.auth = result.rows[0];
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireCsrf(req, res, next) {
  const supplied = req.get("x-csrf-token");

  if (
    typeof supplied !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(supplied)
  ) {
    return res.status(403).json({
      message: "Invalid CSRF token",
    });
  }

  const suppliedHash = Buffer.from(
    hashToken(supplied), "hex"
  );

  const expectedHash = Buffer.from(
    req.auth.csrf_hash, "hex"
  );

  if (
    suppliedHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(
      suppliedHash, expectedHash
    )
  ) {
    return res.status(403).json({
      message: "Invalid CSRF token",
    });
  }

  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.auth?.role !== role) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    next();
  };
}

module.exports = {
  COOKIE_NAME,
  hashToken,
  generateToken,
  cookieOptions,
  requireAuth,
  requireCsrf,
  requireRole,
};
