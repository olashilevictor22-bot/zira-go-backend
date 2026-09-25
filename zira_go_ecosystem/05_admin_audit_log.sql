-- 05_admin_audit_log.sql
-- Every admin-portal action that changes state (wallet adjustments, driver
-- flag/ban toggles, content and ad-banner edits, broadcasts, platform config)
-- previously left no trace of *which* admin did it or *what* it changed —
-- only the resulting row. This adds a single append-only audit trail, and
-- zira_go_admin_routes.js now writes to it from every such endpoint.
-- Safe to run against an existing database.

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           BIGSERIAL PRIMARY KEY,
    admin_id     BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    admin_email  TEXT,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    details      JSONB,
    ip_address   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log (target_type, target_id);
