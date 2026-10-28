-- adm domain (admin.db, standalone SQLite). 0001: initial schema.
CREATE TABLE IF NOT EXISTS adm_admins (
    admin_id    INTEGER PRIMARY KEY,
    username    TEXT    NOT NULL UNIQUE,
    pw_hash     TEXT    NOT NULL,
    totp_secret TEXT    NOT NULL,
    role        INTEGER NOT NULL DEFAULT 2,  -- 0 superadmin / 1 ops / 2 moderator
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adm_admin_sessions (
    sid        TEXT    PRIMARY KEY,
    admin_id   INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    csrf       TEXT    NOT NULL
);
