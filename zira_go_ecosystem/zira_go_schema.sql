-- Zira Go schema additions
-- Sits on top of existing ZiraPay tables: students/users, drivers, transport_routes,
-- transport_driver_routes. Adjust FK column names below to match your actual table/column
-- names (assumed here: students.id, drivers.id).

-- ============================================================
-- 1. Trip sessions — one row per vehicle run
-- ============================================================
CREATE TABLE IF NOT EXISTS trip_sessions (
    id              BIGSERIAL PRIMARY KEY,
    driver_id       BIGINT NOT NULL REFERENCES drivers(id),
    mode            TEXT NOT NULL CHECK (mode IN ('complete_ride', 'charter')),
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),

    -- The driver selects the vehicle's safe passenger capacity at trip start.
    seat_capacity  INT NOT NULL DEFAULT 4 CHECK (seat_capacity BETWEEN 1 AND 60),
    seats_filled    INT NOT NULL DEFAULT 0,
    total_collected NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- charter only: the total fare the driver set for the ride (null for complete_ride)
    charter_fare    NUMERIC(10,2),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trip_sessions_driver_status ON trip_sessions(driver_id, status);

-- Safe for existing Zira Go databases created before configurable capacity.
ALTER TABLE trip_sessions ADD COLUMN IF NOT EXISTS seat_capacity INT NOT NULL DEFAULT 4;
ALTER TABLE trip_sessions DROP CONSTRAINT IF EXISTS trip_sessions_seat_capacity_check;
ALTER TABLE trip_sessions ADD CONSTRAINT trip_sessions_seat_capacity_check CHECK (seat_capacity BETWEEN 1 AND 60);

-- ============================================================
-- 2. One-time codes
-- ============================================================
CREATE TABLE IF NOT EXISTS one_time_codes (
    id          BIGSERIAL PRIMARY KEY,
    student_id  BIGINT NOT NULL REFERENCES students(id),
    code_hash   TEXT NOT NULL,                -- hash the code, never store it plain
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'expired')),
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_one_time_codes_student_status ON one_time_codes(student_id, status);

-- ============================================================
-- 3. Trip charges — one row per passenger payment within a trip session
-- ============================================================
CREATE TABLE IF NOT EXISTS trip_charges (
    id                  BIGSERIAL PRIMARY KEY,
    trip_session_id     BIGINT NOT NULL REFERENCES trip_sessions(id),
    student_id          BIGINT NOT NULL REFERENCES students(id),

    auth_method         TEXT NOT NULL CHECK (auth_method IN ('reg_no_pin', 'one_time_code')),
    fare_amount         NUMERIC(10,2) NOT NULL CHECK (fare_amount > 0), -- what the student is charged (250 or driver-set)
    platform_fee        NUMERIC(10,2) NOT NULL DEFAULT 10, -- the ₦10 transaction fee, charged to the driver

    status              TEXT NOT NULL CHECK (status IN ('success', 'failed_insufficient_funds', 'failed_auth')),
    one_time_code_id    BIGINT REFERENCES one_time_codes(id), -- null when paid via reg_no_pin

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_charges_session ON trip_charges(trip_session_id);
CREATE INDEX IF NOT EXISTS idx_trip_charges_student ON trip_charges(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_successful_charge_per_student_trip
  ON trip_charges(trip_session_id, student_id) WHERE status = 'success';

-- Enforce the Complete Ride caps (250/seat, 4 seats, 1000 total) at the DB level as a backstop
-- to whatever the app already checks — belt and suspenders, since the driver's own phone is
-- the point of entry and shouldn't be the only thing enforcing this.
CREATE OR REPLACE FUNCTION enforce_complete_ride_caps() RETURNS TRIGGER AS $$
DECLARE
    v_mode TEXT;
    v_seats INT;
    v_total NUMERIC(10,2);
    v_capacity INT;
BEGIN
    IF NEW.status != 'success' THEN
        RETURN NEW;
    END IF;

    SELECT mode, seats_filled, total_collected, seat_capacity INTO v_mode, v_seats, v_total, v_capacity
    FROM trip_sessions WHERE id = NEW.trip_session_id FOR UPDATE;

    IF v_mode = 'complete_ride' THEN
        IF NEW.fare_amount > 250 THEN
            RAISE EXCEPTION 'Complete Ride charges cannot exceed 250';
        END IF;
        IF v_seats >= v_capacity THEN
            RAISE EXCEPTION 'Complete Ride trip session is at vehicle capacity';
        END IF;
    END IF;

    UPDATE trip_sessions
    SET seats_filled = seats_filled + 1,
        total_collected = total_collected + NEW.fare_amount
    WHERE id = NEW.trip_session_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_complete_ride_caps ON trip_charges;
CREATE TRIGGER trg_enforce_complete_ride_caps
    BEFORE INSERT ON trip_charges
    FOR EACH ROW EXECUTE FUNCTION enforce_complete_ride_caps();

-- ============================================================
-- 4. Wallet ledger — every naira movement, tagged by fee type
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id            BIGSERIAL PRIMARY KEY,
    student_id    BIGINT REFERENCES students(id),   -- null for driver-side withdrawal rows
    driver_id     BIGINT REFERENCES drivers(id),     -- null for student-side rows

    type          TEXT NOT NULL CHECK (type IN ('funding', 'ride_debit', 'ride_credit', 'withdrawal', 'admin_credit', 'admin_debit')),
    amount        NUMERIC(10,2) NOT NULL,
    fee_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
    fee_type      TEXT CHECK (fee_type IN ('funding_fee', 'transaction_fee', 'withdrawal_fee')),

    reference_id  BIGINT,  -- points at trip_charges.id or a funding/withdrawal record, depending on type
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_student ON wallet_transactions(student_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_driver ON wallet_transactions(driver_id);

-- ============================================================
-- 5. Fraud controls: PIN attempts + one-time code guess flagging
-- ============================================================

-- One row per PIN attempt on a reg_no_pin charge. Capped at 3 attempts per charge attempt
-- (not a global wallet lock) — enforced in app logic by counting rows for the same
-- trip_session_id + student_id within a short window (e.g. 2 minutes) before allowing another try.
CREATE TABLE IF NOT EXISTS pin_attempts (
    id                BIGSERIAL PRIMARY KEY,
    student_id        BIGINT NOT NULL REFERENCES students(id),
    trip_session_id   BIGINT NOT NULL REFERENCES trip_sessions(id),
    success           BOOLEAN NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pin_attempts_lookup ON pin_attempts(student_id, trip_session_id, created_at);

-- One row per one-time-code guess by a driver. A driver is flagged after 5 wrong guesses
-- in a row (a success resets the streak) — computed in app logic from the most recent rows
-- for that driver_id, then written to drivers.is_flagged.
CREATE TABLE IF NOT EXISTS code_guess_attempts (
    id          BIGSERIAL PRIMARY KEY,
    driver_id   BIGINT NOT NULL REFERENCES drivers(id),
    success     BOOLEAN NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_guess_driver ON code_guess_attempts(driver_id, created_at);

-- Add flag columns to the existing drivers table
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
