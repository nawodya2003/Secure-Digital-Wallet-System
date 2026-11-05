
BEGIN;

-- 1. Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(150) NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Wallets
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id),

    currency CHAR(3) NOT NULL DEFAULT 'LKR'
        CHECK (currency = 'LKR'),

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'frozen', 'closed')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, currency),
    UNIQUE (id, currency)
);

-- 3. Ledger accounts
CREATE TABLE ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    wallet_id UUID UNIQUE REFERENCES wallets(id),

    account_type VARCHAR(20) NOT NULL
        CHECK (account_type IN ('wallet', 'clearing')),

    currency CHAR(3) NOT NULL DEFAULT 'LKR'
        CHECK (currency = 'LKR'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        (account_type = 'wallet' AND wallet_id IS NOT NULL)
        OR
        (account_type = 'clearing' AND wallet_id IS NULL)
    ),

    FOREIGN KEY (wallet_id, currency)
        REFERENCES wallets(id, currency)
);

-- 4. Transfer records
CREATE TABLE transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    sender_wallet_id UUID NOT NULL
        REFERENCES wallets(id),

    receiver_wallet_id UUID NOT NULL
        REFERENCES wallets(id),

    amount_cents BIGINT NOT NULL
        CHECK (amount_cents > 0),

    currency CHAR(3) NOT NULL DEFAULT 'LKR'
        CHECK (currency = 'LKR'),

    idempotency_key VARCHAR(100) NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'completed', 'failed'
        )),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CHECK (sender_wallet_id <> receiver_wallet_id),

    UNIQUE (sender_wallet_id, idempotency_key),

    FOREIGN KEY (sender_wallet_id, currency)
        REFERENCES wallets(id, currency),

    FOREIGN KEY (receiver_wallet_id, currency)
        REFERENCES wallets(id, currency)
);

-- 5. Immutable financial entries
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    transfer_id UUID NOT NULL
        REFERENCES transfers(id),

    account_id UUID NOT NULL
        REFERENCES ledger_accounts(id),

    amount_cents BIGINT NOT NULL
        CHECK (amount_cents <> 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (transfer_id, account_id)
);

-- 6. Audit events
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    actor_user_id UUID REFERENCES users(id),

    event_type VARCHAR(100) NOT NULL,

    entity_type VARCHAR(60) NOT NULL,
    entity_id UUID,

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Useful indexes
CREATE INDEX idx_wallets_user
    ON wallets(user_id);

CREATE INDEX idx_transfers_sender_created
    ON transfers(sender_wallet_id, created_at DESC);

CREATE INDEX idx_transfers_receiver_created
    ON transfers(receiver_wallet_id, created_at DESC);

CREATE INDEX idx_entries_account
    ON ledger_entries(account_id);

CREATE INDEX idx_entries_transfer
    ON ledger_entries(transfer_id);

CREATE INDEX idx_audit_created
    ON audit_events(created_at DESC);

-- Read-only calculated account balances
CREATE VIEW ledger_balances AS
SELECT
    a.id AS account_id,
    a.wallet_id,
    a.account_type,
    a.currency,
    COALESCE(
        SUM(e.amount_cents), 0
    )::BIGINT AS balance_cents
FROM ledger_accounts a
LEFT JOIN ledger_entries e
    ON e.account_id = a.id
GROUP BY
    a.id, a.wallet_id, a.account_type, a.currency;

COMMIT;
