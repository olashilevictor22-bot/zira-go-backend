-- 07_webauthn_credentials.sql
-- Stores registered WebAuthn (Face ID / Touch ID / fingerprint) platform
-- authenticator credentials, so students can log in without a password.
-- One row per registered device/authenticator; a student can have several
-- (e.g. their phone and a laptop).

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id             BIGSERIAL PRIMARY KEY,
    role           TEXT NOT NULL CHECK (role IN ('student', 'driver')),
    user_id        BIGINT NOT NULL,
    credential_id  TEXT NOT NULL UNIQUE,   -- base64url credential ID from the authenticator
    public_key     TEXT NOT NULL,          -- base64-encoded COSE public key
    counter        BIGINT NOT NULL DEFAULT 0,
    device_type    TEXT,                   -- 'singleDevice' | 'multiDevice'
    backed_up      BOOLEAN NOT NULL DEFAULT false,
    transports     TEXT,                   -- comma-separated, e.g. "internal"
    nickname       TEXT,                   -- e.g. "iPhone Face ID"
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials (role, user_id);
