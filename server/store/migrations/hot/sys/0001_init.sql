-- sys domain (hot, SQLite). 0001: initial schema.
CREATE TABLE IF NOT EXISTS sys_presence (
    uid       INTEGER PRIMARY KEY,
    online    INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL
);

-- fixed-window counter buckets; thresholds live in policy.json, never in code
CREATE TABLE IF NOT EXISTS sys_rate_limit (
    subject       TEXT    NOT NULL,
    action        TEXT    NOT NULL,
    window_start  INTEGER NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (subject, action, window_start)
);

CREATE TABLE IF NOT EXISTS sys_rate_limit_penalty (
    subject TEXT    NOT NULL,
    penalty TEXT    NOT NULL,
    until   INTEGER NOT NULL,
    PRIMARY KEY (subject, penalty)
);

CREATE TABLE IF NOT EXISTS sys_feature_flags (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL,   -- json
    version INTEGER NOT NULL DEFAULT 1
);
