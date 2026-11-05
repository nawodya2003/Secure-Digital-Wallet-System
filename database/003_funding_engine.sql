BEGIN;

-- 1. Demo funding requests
CREATE TABLE demo_fundings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    wallet_id UUID NOT NULL
        REFERENCES wallets(id),

    amount_cents BIGINT NOT NULL
        CHECK (amount_cents > 0),

    currency CHAR(3) NOT NULL DEFAULT 'LKR'
        CHECK (currency = 'LKR'),

    idempotency_key VARCHAR(100) NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    UNIQUE (wallet_id, idempotency_key),

    FOREIGN KEY (wallet_id, currency)
        REFERENCES wallets(id, currency)
);

-- 2. Allow ledger entries for either transfers
--    OR demo fundings
ALTER TABLE ledger_entries
    ALTER COLUMN transfer_id DROP NOT NULL;

ALTER TABLE ledger_entries
    ADD COLUMN funding_id UUID
        REFERENCES demo_fundings(id);

ALTER TABLE ledger_entries
    ADD CONSTRAINT exactly_one_posting_source
    CHECK (
        num_nonnulls(transfer_id, funding_id) = 1
    );

CREATE UNIQUE INDEX idx_funding_account_unique
    ON ledger_entries(funding_id, account_id);

-- 3. Only one clearing account per currency
CREATE UNIQUE INDEX idx_clearing_currency
    ON ledger_accounts(currency)
    WHERE account_type = 'clearing';

-- Create demo clearing account
INSERT INTO ledger_accounts(account_type, currency)
SELECT 'clearing', 'LKR'
WHERE NOT EXISTS (
    SELECT 1
    FROM ledger_accounts
    WHERE account_type = 'clearing'
      AND currency = 'LKR'
);

-- 4. Prevent funding history modifications
CREATE FUNCTION protect_demo_fundings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Demo funding deletion is forbidden';
    END IF;

    IF OLD.status = 'completed' THEN
        RAISE EXCEPTION
            'Completed funding cannot change';
    END IF;

    IF NEW.status = 'completed'
       AND OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'Invalid funding transition';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_demo_funding_history
BEFORE UPDATE OR DELETE ON demo_fundings
FOR EACH ROW
EXECUTE FUNCTION protect_demo_fundings();

-- 5. Validate funding postings at transaction end
CREATE FUNCTION verify_demo_funding_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    f demo_fundings%ROWTYPE;
    target_id UUID;
    n INTEGER;
    total NUMERIC;
    matches INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'demo_fundings' THEN
        target_id := NEW.id;
    ELSE
        target_id := NEW.funding_id;
    END IF;

    IF target_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO f
    FROM demo_fundings
    WHERE id = target_id;

    IF NOT FOUND OR f.status <> 'completed' THEN
        RETURN NULL;
    END IF;

    SELECT
        COUNT(*),
        COALESCE(SUM(e.amount_cents), 0),
        COUNT(*) FILTER (
            WHERE a.currency = f.currency
              AND (
                  (
                    a.account_type = 'wallet'
                    AND a.wallet_id = f.wallet_id
                    AND e.amount_cents = f.amount_cents
                  )
                  OR
                  (
                    a.account_type = 'clearing'
                    AND e.amount_cents = -f.amount_cents
                  )
              )
        )
    INTO n, total, matches
    FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.funding_id = target_id;

    IF n <> 2 OR total <> 0 OR matches <> 2 THEN
        RAISE EXCEPTION
            'Invalid completed demo funding ledger'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_demo_funding
AFTER INSERT OR UPDATE ON demo_fundings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_demo_funding_ledger();

CREATE CONSTRAINT TRIGGER validate_demo_funding_entry
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_demo_funding_ledger();

COMMIT;
