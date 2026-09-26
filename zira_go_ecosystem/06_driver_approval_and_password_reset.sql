-- 06_driver_approval_and_password_reset.sql
-- Two independent additions, bundled together because they shipped together:
--
-- 1. Driver approval workflow: new driver signups now start under review
--    instead of being able to drive immediately. Existing driver rows are
--    explicitly backfilled to 'approved' so nobody already active is
--    affected — only accounts created after this runs start 'pending'.
--    zira_go_auth_routes.js, zira_go_driver_routes.js, zira_go_trip_routes.js
--    and zira_go_admin_routes.js all read/write approval_status.
--
-- 2. Password reset: a single-use, short-lived token table backing the new
--    /api/auth/forgot-password and /api/auth/reset-password endpoints. Only
--    a SHA-256 hash of the token is stored, never the raw value.
--
-- Safe to run against an existing database. This is also self-healed at
-- boot by zira_go_auth_routes.js, so running this file by hand is optional —
-- it exists for ops teams that prefer an explicit, auditable migration step.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS approval_reviewed_at TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS approval_reviewed_by BIGINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Backfill for safety on databases where the column already existed with a
-- different default (e.g. re-running after a partial apply).
UPDATE drivers SET approval_status = 'approved' WHERE approval_status IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drivers_approval_status_check'
    ) THEN
        ALTER TABLE drivers ADD CONSTRAINT drivers_approval_status_check
            CHECK (approval_status IN ('pending', 'approved', 'rejected'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          BIGSERIAL PRIMARY KEY,
    role        TEXT NOT NULL CHECK (role IN ('student', 'driver')),
    user_id     BIGINT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (role, user_id);
