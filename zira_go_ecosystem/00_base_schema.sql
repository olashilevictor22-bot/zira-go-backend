-- 00_base_schema.sql
-- Base table definitions for students and drivers in case the database is initialized fresh.
-- If these tables already exist in your ZiraPay database, CREATE TABLE IF NOT EXISTS safely skips them.

CREATE TABLE IF NOT EXISTS students (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT UNIQUE,
    full_name       TEXT,
    password_hash   TEXT,
    reg_no          TEXT UNIQUE,
    pin_hash        TEXT,
    wallet_balance  NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT UNIQUE,
    password_hash   TEXT,
    full_name       TEXT,
    wallet_balance  NUMERIC(10,2) NOT NULL DEFAULT 0,
    is_flagged      BOOLEAN NOT NULL DEFAULT false,
    flagged_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
