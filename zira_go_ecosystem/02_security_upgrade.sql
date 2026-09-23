CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  recipient_id BIGINT NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('student','driver','admin')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  action_url TEXT,
  image_url TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_role, recipient_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_gateway_reference_unique ON wallet_transactions(gateway_reference) WHERE gateway_reference IS NOT NULL;
ALTER TABLE students ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE one_time_codes ADD COLUMN IF NOT EXISTS raw_code TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check CHECK (type IN ('funding', 'ride_debit', 'ride_credit', 'withdrawal', 'admin_credit', 'admin_debit'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_request_active_per_student ON pin_change_requests(student_id) WHERE status IN ('pending','approved');

-- Seeded rows may have been inserted with explicit IDs; keep generated IDs ahead of them.
SELECT setval(pg_get_serial_sequence('students', 'id'), COALESCE((SELECT MAX(id) FROM students), 1), true);
SELECT setval(pg_get_serial_sequence('drivers', 'id'), COALESCE((SELECT MAX(id) FROM drivers), 1), true);
SELECT setval(pg_get_serial_sequence('admins', 'id'), COALESCE((SELECT MAX(id) FROM admins), 1), true);
