-- Zira Go — Telegram linking schema addition
-- Lets a student OR a driver connect their Telegram account to their existing
-- ZiraPay record, so the bot can generate one-time ride codes, push instant
-- notifications, and (for drivers) surface flagged-account alerts — without
-- ever handling PIN or wallet logic itself.

-- ============================================================
-- 1. Chat ID on students and drivers
-- ============================================================
-- Nullable — most accounts will still exist without ever touching Telegram.
-- Unique so one Telegram account can't be linked to two different students,
-- and separately can't be linked to two different drivers.
ALTER TABLE students ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_students_telegram_chat_id ON students(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_drivers_telegram_chat_id ON drivers(telegram_chat_id);

-- ============================================================
-- 2. Link codes — short-lived codes shown in the web app / driver panel,
--    typed into the bot to prove account ownership.
--    Exactly one of student_id / driver_id is set per row, never both —
--    same table serves both linking flows so the bot has one lookup path.
-- ============================================================
CREATE TABLE IF NOT EXISTS telegram_link_codes (
    id          BIGSERIAL PRIMARY KEY,
    student_id  BIGINT REFERENCES students(id),
    driver_id   BIGINT REFERENCES drivers(id),
    code_hash   TEXT NOT NULL,                -- same hashing convention as one_time_codes
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'expired')),
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT telegram_link_codes_exactly_one_owner CHECK (
        (student_id IS NOT NULL AND driver_id IS NULL) OR
        (student_id IS NULL AND driver_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_student_status ON telegram_link_codes(student_id, status);
CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_driver_status ON telegram_link_codes(driver_id, status);

-- A student/driver can only have one active link code at a time — app logic should
-- expire/replace the previous one when generating a new one, this index just makes
-- the bot's lookup cheap regardless of which side the code belongs to.
CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_active_lookup ON telegram_link_codes(code_hash, status);
