-- 04_charter_fare_guard.sql
-- Backstop for the charter-fare bug: previously a driver-supplied charter fare
-- (fareAmount) reached executeCharge() with no validation, so a negative or
-- non-finite value slipped past the `balance < fareAmount` check and could
-- credit a student's wallet / debit a driver's wallet arbitrarily. The app
-- now rejects this in zira_go_trip_routes.js, but this constraint enforces
-- the same rule at the database level as a backstop, matching the existing
-- Complete Ride cap trigger's "belt and suspenders" approach.
-- Safe to run against an existing database.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'trip_charges_fare_amount_check'
    ) THEN
        ALTER TABLE trip_charges ADD CONSTRAINT trip_charges_fare_amount_check CHECK (fare_amount > 0);
    END IF;
END $$;
