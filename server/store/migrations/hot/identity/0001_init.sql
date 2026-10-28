-- identity domain (hot, SQLite). 0001: initial schema.
CREATE TABLE IF NOT EXISTS identity_users (
    uid              INTEGER PRIMARY KEY,
    display_name     TEXT    NOT NULL,
    avatar_media_id  INTEGER,
    status           INTEGER NOT NULL DEFAULT 0, -- 0 normal / 1 banned / 2 deletion-cooling / 3 deleted
    created_at       INTEGER NOT NULL,
    anonymous_at     INTEGER                      -- NULL = not yet anonymized
);

CREATE TABLE IF NOT EXISTS identity_identities (
    id_type     INTEGER NOT NULL,   -- login-identity type enum
    id_value    TEXT    NOT NULL,   -- HMAC(index value); raw identity never stored
    uid         INTEGER NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (id_type, id_value)
);
CREATE INDEX IF NOT EXISTS idx_identity_identities_uid ON identity_identities (uid);

CREATE TABLE IF NOT EXISTS identity_devices (
    device_id   TEXT    PRIMARY KEY,
    uid         INTEGER NOT NULL,
    platform    TEXT,
    last_seen   INTEGER NOT NULL,
    push_token  TEXT
);
CREATE INDEX IF NOT EXISTS idx_identity_devices_uid ON identity_devices (uid);

CREATE TABLE IF NOT EXISTS identity_bans (
    uid         INTEGER NOT NULL,
    level       INTEGER NOT NULL,  -- policy-defined tier, never hardcoded in code
    reason      TEXT,
    until       INTEGER NOT NULL,  -- 0 = permanent
    created_by  TEXT    NOT NULL,  -- admin actor id
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_bans_uid ON identity_bans (uid);
