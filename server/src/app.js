const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { checkDatabase } = require("./db");
const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
  origin: "http://localhost:5173"
}));

app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "SecurePay Backend is Running"
  });
});

module.exports = app;
