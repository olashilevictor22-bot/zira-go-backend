-- Zira Go — Auth + Bank Account Verification schema additions
-- Sits on top of zira_go_schema.sql and zira_go_telegram_schema.sql.

-- ============================================================
-- 1. Login credentials for students and drivers
-- ============================================================
-- Kept separate from students.pin_hash / the wallet PIN on purpose — the login
-- password gets you INTO the account; the transaction PIN authorizes a charge
-- once you're already in. Conflating them means a shoulder-surfed login
-- password would also unlock ride payments, which we don't want.
ALTER TABLE students ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS reg_no TEXT UNIQUE;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS full_name TEXT;

-- ============================================================
-- 2. Bank account on file — verified once via a resolve API call
--    (Paystack/Korapay-style), then LOCKED. Nothing after that point can
--    write account_number/account_name directly; only an approved row in
--    bank_account_change_requests can move those fields (see trigger below).
-- ============================================================
ALTER TABLE students ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS bank_account_name TEXT;      -- name returned by the resolve API, never typed by the user
ALTER TABLE students ADD COLUMN IF NOT EXISTS bank_verified_at TIMESTAMPTZ;
ALTER TABLE students ADD COLUMN IF NOT EXISTS bank_locked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_verified_at TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_locked BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 3. Admin accounts — separate from students/drivers, reviews change requests
-- ============================================================
CREATE TABLE admins (
    id             BIGSERIAL PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    full_name      TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. Bank account change requests — the ONLY path to changing a bank
--    account/name once bank_locked = true. A student or driver can submit
--    one any time; nothing is applied until an admin approves it.
-- ============================================================
CREATE TABLE bank_account_change_requests (
    id                      BIGSERIAL PRIMARY KEY,
    student_id              BIGINT REFERENCES students(id),
    driver_id               BIGINT REFERENCES drivers(id),

    current_account_number  TEXT,
    current_account_name    TEXT,
    requested_bank_code     TEXT NOT NULL,
    requested_bank_name     TEXT NOT NULL,
    requested_account_number TEXT NOT NULL,
    requested_account_name  TEXT,             -- filled in by the resolve API once admin re-verifies, not user-supplied
    reason                  TEXT,              -- why the user says they need the change

    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by_admin_id    BIGINT REFERENCES admins(id),
    admin_note              TEXT,
    reviewed_at             TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT bank_change_requests_exactly_one_owner CHECK (
        (student_id IS NOT NULL AND driver_id IS NULL) OR
        (student_id IS NULL AND driver_id IS NOT NULL)
    )
);

CREATE INDEX idx_bank_change_requests_student ON bank_account_change_requests(student_id, status);
CREATE INDEX idx_bank_change_requests_driver ON bank_account_change_requests(driver_id, status);
CREATE INDEX idx_bank_change_requests_pending ON bank_account_change_requests(status) WHERE status = 'pending';

-- Only one pending request per account at a time — stops someone from spamming
-- five different "corrections" while the first is still under review.
CREATE UNIQUE INDEX idx_one_pending_request_per_student
    ON bank_account_change_requests(student_id) WHERE status = 'pending' AND student_id IS NOT NULL;
CREATE UNIQUE INDEX idx_one_pending_request_per_driver
    ON bank_account_change_requests(driver_id) WHERE status = 'pending' AND driver_id IS NOT NULL;
