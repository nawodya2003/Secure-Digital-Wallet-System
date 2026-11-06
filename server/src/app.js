const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const { rateLimit } = require("express-rate-limit");
const { pool, checkDatabase } = require("./db");
const createAuthRouter = require("./auth/authRouter");
const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  credentials: true,
}));

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: "draft-8", legacyHeaders: false });
app.use("/api", apiLimiter);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "SecurePay Backend is Running"
  });
});

app.get("/api/ready", async (req, res) => {
  try {
    if (!(await checkDatabase())) return res.status(503).json({ success: false, message: "Database unavailable" });
    res.json({ success: true, message: "API and database are ready" });
  } catch {
    res.status(503).json({ success: false, message: "Database unavailable" });
  }
});

app.use("/api", createAuthRouter(pool));
app.use((req, res) => res.status(404).json({ message: "Route not found" }));
app.use((error, req, res, next) => {
  console.error("API error:", error.message);
  res.status(500).json({ message: "Internal server error" });
});

module.exports = app;
