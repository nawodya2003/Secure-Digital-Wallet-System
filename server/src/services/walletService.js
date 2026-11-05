

const { randomUUID } = require("node:crypto");

class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

// Only positive integer cents are accepted.
// JSON APIs should provide money as strings.
function parseAmount(value) {
  const text = typeof value === "bigint"
    ? value.toString()
    : value;

  if (
    typeof text !== "string" ||
    !/^[1-9][0-9]*$/.test(text)
  ) {
    throw new WalletError(
      "INVALID_AMOUNT",
      "Amount must be a positive integer string in cents"
    );
  }

  const amount = BigInt(text);

  // Demo maximum: Rs. 1,000,000 per operation
  if (amount > 100000000n) {
    throw new WalletError(
      "LIMIT_EXCEEDED",
      "Demo transaction limit exceeded"
    );
  }

  return amount;
}

function validateKey(key) {
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(key)
  ) {
    throw new WalletError(
      "INVALID_KEY",
      "A valid idempotency key is required"
    );
  }
}

async function withTransaction(pool, work) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SET LOCAL statement_timeout = '15s'"
    );

    const result = await work(client);

    // Includes deferred constraint checks
    await client.query("COMMIT");

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Rollback failed:",
        rollbackError.message
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

// Lock wallets in consistent UUID order.
// Every writer must obey this protocol.
async function lockWallets(client, walletIds) {
  const ids = [...new Set(walletIds)].sort();

  const result = [];

  for (const id of ids) {
    const query = await client.query(
      `SELECT id, user_id, currency, status
       FROM wallets
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (query.rowCount !== 1) {
      throw new WalletError(
        "WALLET_NOT_FOUND",
        "Wallet does not exist"
      );
    }

    result.push(query.rows[0]);
  }

  return result;
}

function ensureActive(wallets) {
  for (const wallet of wallets) {
    if (wallet.status !== "active") {
      throw new WalletError(
        "WALLET_BLOCKED",
        "Wallet is not active"
      );
    }
  }
}

async function getAccount(client, walletId) {
  const result = await client.query(
    `SELECT id, currency
     FROM ledger_accounts
     WHERE wallet_id = $1
       AND account_type = 'wallet'`,
    [walletId]
  );

  if (result.rowCount !== 1) {
    throw new WalletError(
      "ACCOUNT_NOT_FOUND",
      "Ledger account not found"
    );
  }

  return result.rows[0];
}

async function accountBalance(client, accountId) {
  const result = await client.query(
    `SELECT COALESCE(
       SUM(amount_cents), 0
     )::text AS balance
     FROM ledger_entries
     WHERE account_id = $1`,
    [accountId]
  );

  return BigInt(result.rows[0].balance);
}

async function audit(client, eventType, entityType, entityId) {
  await client.query(
    `INSERT INTO audit_events(
       event_type, entity_type, entity_id
     )
     VALUES ($1, $2, $3)`,
    [eventType, entityType, entityId]
  );
}

// LOCAL DEVELOPMENT ONLY.
// Authentication comes in a later lesson.
async function createDemoWallet(pool, email, fullName) {
  return withTransaction(pool, async (client) => {
    const user = await client.query(
      `INSERT INTO users(email, full_name)
       VALUES ($1, $2)
       RETURNING id`,
      [email, fullName]
    );

    const wallet = await client.query(
      `INSERT INTO wallets(user_id)
       VALUES ($1)
       RETURNING id`,
      [user.rows[0].id]
    );

    const account = await client.query(
      `INSERT INTO ledger_accounts(
         wallet_id, account_type, currency
       )
       VALUES ($1, 'wallet', 'LKR')
       RETURNING id`,
      [wallet.rows[0].id]
    );

    return {
      userId: user.rows[0].id,
      walletId: wallet.rows[0].id,
      accountId: account.rows[0].id,
    };
  });
}

// Authorized local demo funding only
async function fundDemoWallet(
  pool,
  { walletId, amountCents, idempotencyKey }
) {
  const amount = parseAmount(amountCents);
  validateKey(idempotencyKey);

  return withTransaction(pool, async (client) => {
    const wallets = await lockWallets(client, [walletId]);
    ensureActive(wallets);

    const previous = await client.query(
      `SELECT id, amount_cents, status
       FROM demo_fundings
       WHERE wallet_id = $1
         AND idempotency_key = $2`,
      [walletId, idempotencyKey]
    );

    if (previous.rowCount) {
      const old = previous.rows[0];

      if (BigInt(old.amount_cents) !== amount) {
        throw new WalletError(
          "IDEMPOTENCY_CONFLICT",
          "Key already used for different funding"
        );
      }

      if (old.status !== "completed") {
        throw new WalletError(
          "FUNDING_PENDING",
          "Funding has not completed"
        );
      }

      return {
        fundingId: old.id,
        status: old.status,
        replayed: true,
      };
    }

    const walletAccount = await getAccount(
      client,
      walletId
    );

    const clearing = await client.query(
      `SELECT id FROM ledger_accounts
       WHERE account_type = 'clearing'
         AND currency = 'LKR'`
    );

    if (clearing.rowCount !== 1) {
      throw new WalletError(
        "CLEARING_MISSING",
        "Demo clearing account is missing"
      );
    }

    const funding = await client.query(
      `INSERT INTO demo_fundings(
         wallet_id, amount_cents, idempotency_key
       )
       VALUES ($1, $2, $3)
       RETURNING id`,
      [walletId, amount.toString(), idempotencyKey]
    );

    const fundingId = funding.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries(
         funding_id, account_id, amount_cents
       )
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [
        fundingId,
        clearing.rows[0].id,
        (-amount).toString(),
        walletAccount.id,
        amount.toString(),
      ]
    );

    await client.query(
      `UPDATE demo_fundings
       SET status = 'completed',
           completed_at = NOW()
       WHERE id = $1`,
      [fundingId]
    );

    await audit(
      client, "DEMO_FUNDING_COMPLETED",
      "demo_funding", fundingId
    );

    return {
      fundingId,
      status: "completed",
      replayed: false,
    };
  });
}

// Atomic wallet-to-wallet transfer
async function transferMoney(
  pool,
  {
    senderWalletId,
    receiverWalletId,
    amountCents,
    idempotencyKey,
  }
) {
  const amount = parseAmount(amountCents);
  validateKey(idempotencyKey);

  if (senderWalletId === receiverWalletId) {
    throw new WalletError(
      "SAME_WALLET",
      "Sender and receiver must differ"
    );
  }

  return withTransaction(pool, async (client) => {
    const wallets = await lockWallets(
      client,
      [senderWalletId, receiverWalletId]
    );

    ensureActive(wallets);

    if (wallets.some(w => w.currency !== "LKR")) {
      throw new WalletError(
        "CURRENCY_ERROR",
        "Only LKR is supported"
      );
    }

    // Lock first, then check for earlier requests.
    const previous = await client.query(
      `SELECT id, receiver_wallet_id,
              amount_cents, status
       FROM transfers
       WHERE sender_wallet_id = $1
         AND idempotency_key = $2`,
      [senderWalletId, idempotencyKey]
    );

    if (previous.rowCount) {
      const old = previous.rows[0];

      if (
        old.receiver_wallet_id !== receiverWalletId ||
        BigInt(old.amount_cents) !== amount
      ) {
        throw new WalletError(
          "IDEMPOTENCY_CONFLICT",
          "Key already used for another request"
        );
      }

      if (old.status !== "completed") {
        throw new WalletError(
          "TRANSFER_PENDING",
          "Transfer is not completed"
        );
      }

      return {
        transferId: old.id,
        status: old.status,
        replayed: true,
      };
    }

    const sender = await getAccount(
      client,
      senderWalletId
    );

    const receiver = await getAccount(
      client,
      receiverWalletId
    );

    // Safe because every service writer locks
    // relevant wallet rows before posting entries.
    const balance = await accountBalance(
      client,
      sender.id
    );

    if (balance < amount) {
      throw new WalletError(
        "INSUFFICIENT_FUNDS",
        "Not enough money in sender wallet"
      );
    }

    const transfer = await client.query(
      `INSERT INTO transfers(
         sender_wallet_id,
         receiver_wallet_id,
         amount_cents,
         idempotency_key
       )
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        senderWalletId,
        receiverWalletId,
        amount.toString(),
        idempotencyKey,
      ]
    );

    const transferId = transfer.rows[0].id;

    // Debit sender, credit receiver
    await client.query(
      `INSERT INTO ledger_entries(
         transfer_id, account_id, amount_cents
       )
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [
        transferId,
        sender.id,
        (-amount).toString(),
        receiver.id,
        amount.toString(),
      ]
    );

    await client.query(
      `UPDATE transfers
       SET status = 'completed',
           completed_at = NOW()
       WHERE id = $1`,
      [transferId]
    );

    await audit(
      client, "TRANSFER_COMPLETED",
      "transfer", transferId
    );

    return {
      transferId,
      status: "completed",
      replayed: false,
    };
  });
}

async function getWalletBalance(pool, walletId) {
  const result = await pool.query(
    `SELECT balance_cents
     FROM ledger_balances
     WHERE wallet_id = $1`,
    [walletId]
  );

  if (result.rowCount !== 1) {
    throw new WalletError(
      "WALLET_NOT_FOUND",
      "Wallet balance not found"
    );
  }

  return result.rows[0].balance_cents.toString();
}

module.exports = {
  WalletError,
  createDemoWallet,
  fundDemoWallet,
  transferMoney,
  getWalletBalance,
  withTransaction,
};
