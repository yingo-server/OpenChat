-- media domain (hot, SQLite). 0001: initial schema.
CREATE TABLE IF NOT EXISTS media_media (
    media_id     TEXT    PRIMARY KEY,            -- base64url, >= 22 chars
    uid          INTEGER NOT NULL,
    mtype        INTEGER NOT NULL,
    name         TEXT,
    size         INTEGER NOT NULL,
    mime         TEXT,
    width        INTEGER,
    height       INTEGER,
    duration_ms  INTEGER,
    status       INTEGER NOT NULL DEFAULT 0,     -- 0 scanning / 1 usable / 2 violation
    sha256       TEXT,
    created_at   INTEGER NOT NULL,
    ref_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_media_uid ON media_media (uid);
CREATE INDEX IF NOT EXISTS idx_media_media_status ON media_media (status);
