-- identity domain (cold, PostgreSQL). 0001: login history (append-only).
CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.login_history (
    id      BIGSERIAL PRIMARY KEY,
    uid     BIGINT  NOT NULL,
    id_type INTEGER NOT NULL,
    ok      BOOLEAN NOT NULL,
    ip      INET,
    ua      TEXT,
    at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_history_uid ON identity.login_history (uid, at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_ip ON identity.login_history (ip, at DESC);
