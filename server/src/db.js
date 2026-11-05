const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
  max: 10,
});

async function checkDatabase() {
  const result = await pool.query("SELECT 1 AS connected");
  return result.rows[0].connected === 1;
}

module.exports = {
  pool,
  checkDatabase,
};
