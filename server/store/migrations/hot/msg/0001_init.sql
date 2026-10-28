-- msg domain (hot, SQLite). 0001: initial schema.
CREATE TABLE IF NOT EXISTS msg_messages_hot (
    msg_id        INTEGER PRIMARY KEY,           -- snowflake
    cid           INTEGER NOT NULL,
    seq           INTEGER NOT NULL,              -- per-conversation monotonic
    sender_id     INTEGER NOT NULL,
    client_msg_id TEXT,
    content       BLOB,                          -- Envelope payload, stored verbatim
    sent_at       INTEGER NOT NULL,
    edited        INTEGER NOT NULL DEFAULT 0,
    recalled      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (cid, seq),
    UNIQUE (cid, sender_id, client_msg_id)      -- dedupguard idempotency
);
CREATE INDEX IF NOT EXISTS idx_msg_cid_seq ON msg_messages_hot (cid, seq);
CREATE INDEX IF NOT EXISTS idx_msg_sent    ON msg_messages_hot (sent_at);
