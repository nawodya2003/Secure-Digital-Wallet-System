
BEGIN;

-- Prevent modification of financial history
CREATE FUNCTION prevent_ledger_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Ledger entries cannot be updated or deleted';
END;
$$;

CREATE TRIGGER ledger_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_changes();


-- Verify each completed transfer
CREATE FUNCTION verify_transfer_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    transfer_record transfers%ROWTYPE;
    entry_count INTEGER;
    entry_sum NUMERIC;
    matching_entries INTEGER;
    target_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'transfers' THEN
        target_id := NEW.id;
    ELSE
        target_id := NEW.transfer_id;
    END IF;

    SELECT *
    INTO transfer_record
    FROM transfers
    WHERE id = target_id;

    IF NOT FOUND OR transfer_record.status <> 'completed' THEN
        RETURN NULL;
    END IF;

    SELECT
        COUNT(*),
        COALESCE(SUM(e.amount_cents), 0),
        COUNT(*) FILTER (
            WHERE
                (
                    e.amount_cents = -transfer_record.amount_cents
                    AND a.wallet_id =
                        transfer_record.sender_wallet_id
                )
                OR
                (
                    e.amount_cents = transfer_record.amount_cents
                    AND a.wallet_id =
                        transfer_record.receiver_wallet_id
                )
        )
    INTO
        entry_count,
        entry_sum,
        matching_entries
    FROM ledger_entries e
    JOIN ledger_accounts a
        ON a.id = e.account_id
    WHERE e.transfer_id = target_id
      AND a.currency = transfer_record.currency;

    IF entry_count <> 2
       OR entry_sum <> 0
       OR matching_entries <> 2 THEN

        RAISE EXCEPTION
            'Completed transfer % has invalid ledger entries',
            target_id
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

-- Check completed transfer when inserted or updated
CREATE CONSTRAINT TRIGGER validate_transfer_postings
AFTER INSERT OR UPDATE ON transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_transfer_ledger();

-- Check new postings
CREATE CONSTRAINT TRIGGER validate_entry_postings
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_transfer_ledger();


-- Once completed, transfers cannot change
CREATE FUNCTION protect_completed_transfers()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Transfer deletion is not allowed';
    END IF;

    IF OLD.status = 'completed' THEN
        RAISE EXCEPTION
            'Completed transfers cannot be modified';
    END IF;

    IF NEW.status = 'completed'
       AND OLD.status <> 'pending' THEN
        RAISE EXCEPTION
            'Only pending transfers can be completed';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_transfer_history
BEFORE UPDATE OR DELETE ON transfers
FOR EACH ROW
EXECUTE FUNCTION protect_completed_transfers();

COMMIT;
