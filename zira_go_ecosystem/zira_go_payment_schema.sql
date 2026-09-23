-- zira_go_payment_schema.sql
-- Upgrades wallet_transactions and adds driver_withdrawals table

-- ============================================================
-- 1. Upgrade existing wallet_transactions with gateway & receipt fields
-- ============================================================
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success';
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS gateway TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS gateway_reference TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS receipt_number TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_status ON wallet_transactions(status);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_ref ON wallet_transactions(gateway_reference);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_receipt ON wallet_transactions(receipt_number);

-- ============================================================
-- 2. Driver Withdrawals Table
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_withdrawals (
    id                      BIGSERIAL PRIMARY KEY,
    driver_id               BIGINT NOT NULL REFERENCES drivers(id),
    amount                  NUMERIC(10,2) NOT NULL,
    fee                     NUMERIC(10,2) NOT NULL DEFAULT 0,
    bank_code               TEXT NOT NULL,
    bank_name               TEXT NOT NULL,
    account_number          TEXT NOT NULL,
    account_name            TEXT NOT NULL,
    matched_registered_name BOOLEAN NOT NULL DEFAULT true,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
    rejection_reason        TEXT,
    reference               TEXT UNIQUE NOT NULL,
    receipt_number          TEXT UNIQUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_driver_withdrawals_driver ON driver_withdrawals(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_withdrawals_status ON driver_withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_driver_withdrawals_ref ON driver_withdrawals(reference);

-- ============================================================
-- 3. Seed Default Driver & Student Records (if not already seeded)
-- ============================================================
INSERT INTO drivers (id, email, full_name, wallet_balance, bank_code, bank_name, bank_account_number, bank_account_name, bank_locked, is_flagged)
VALUES (1, 'driver@zirapay.com', 'MUSA IBRAHIM YAKUBU', 8450, '044', 'Access Bank', '0123456789', 'MUSA IBRAHIM YAKUBU', true, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO students (id, email, reg_no, wallet_balance, bank_code, bank_name, bank_account_number, bank_account_name, bank_locked)
VALUES (1, 'student@lmu.edu.ng', 'LMU/20/1234', 2500, '058', 'Guaranty Trust Bank', '0123456789', 'STUDENT RIDER', true)
ON CONFLICT (id) DO NOTHING;

