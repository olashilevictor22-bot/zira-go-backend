-- One-time upgrade for databases that already have Zira Go trip tables.
ALTER TABLE trip_sessions
  ADD COLUMN IF NOT EXISTS seat_capacity INT NOT NULL DEFAULT 4;

ALTER TABLE trip_sessions
  DROP CONSTRAINT IF EXISTS trip_sessions_seat_capacity_check;

ALTER TABLE trip_sessions
  ADD CONSTRAINT trip_sessions_seat_capacity_check
  CHECK (seat_capacity BETWEEN 1 AND 60);

CREATE OR REPLACE FUNCTION enforce_complete_ride_caps() RETURNS TRIGGER AS $$
DECLARE
    v_mode TEXT;
    v_seats INT;
    v_capacity INT;
BEGIN
    IF NEW.status != 'success' THEN RETURN NEW; END IF;

    SELECT mode, seats_filled, seat_capacity
      INTO v_mode, v_seats, v_capacity
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_successful_charge_per_student_trip
  ON trip_charges(trip_session_id, student_id) WHERE status = 'success';
