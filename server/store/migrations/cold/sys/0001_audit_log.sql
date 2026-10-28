-- sys domain (cold, PostgreSQL). 0001: audit journal, reports, archive runs ledger.
CREATE SCHEMA IF NOT EXISTS sys;

-- Audit journal: INSERT-only + hash chain. prev_hash links to the previous row's
-- record_hash; the ONLY write entry point is AuditJournal.Append.
CREATE TABLE IF NOT EXISTS sys.audit_log (
    id           BIGSERIAL PRIMARY KEY,
    actor        TEXT    NOT NULL,
    action       TEXT    NOT NULL,
    subject      TEXT    NOT NULL,
    detail       JSONB,
    prev_hash    TEXT,
    record_hash  TEXT    NOT NULL,
    at           BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON sys.audit_log (action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor  ON sys.audit_log (actor, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_subject ON sys.audit_log (subject);

CREATE TABLE IF NOT EXISTS sys.reports (
    id          BIGSERIAL PRIMARY KEY,
    reporter    BIGINT  NOT NULL,
    target_msg  BIGINT,
    target_user BIGINT,
    reason      TEXT,
    status      INTEGER NOT NULL DEFAULT 0,  -- state machine; tiers live in policy/RBAC, not code
    handled_by  TEXT,
    at          BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON sys.reports (status, at DESC);

-- Archive job ledger, shared by all three triggers (cron/API/CLI).
CREATE TABLE IF NOT EXISTS sys.archive_runs (
    id           BIGSERIAL PRIMARY KEY,
    started_at   BIGINT NOT NULL,
    finished_at  BIGINT,
    moved_rows   BIGINT,
    status       TEXT   NOT NULL  -- running / ok / failed
);
