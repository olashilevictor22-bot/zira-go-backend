-- 03_pin_lockout_upgrade.sql
-- Adds escalating wallet-PIN lockout state to students.
-- Tiers: 4 fails -> 10 min lock -> 3 fails -> 30 min lock -> 3 fails -> permanent
-- lock (student must contact support to be reopened by an admin).
-- Safe to run against an existing database — every statement is additive.

ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_lock_stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_permanently_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_permanently_locked_at TIMESTAMPTZ;
