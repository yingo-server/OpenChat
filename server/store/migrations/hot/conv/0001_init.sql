-- conv domain (hot, SQLite). 0001: initial schema.
CREATE TABLE IF NOT EXISTS conv_conversations (
    cid              INTEGER PRIMARY KEY,
    ctype            INTEGER NOT NULL,            -- 1 direct / 2 group
    title            TEXT,
    avatar_media_id  INTEGER,
    created_by       INTEGER NOT NULL,
    created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_conversations_creator ON conv_conversations (created_by);

CREATE TABLE IF NOT EXISTS conv_members (
    cid         INTEGER NOT NULL,
    uid         INTEGER NOT NULL,
    role        INTEGER NOT NULL DEFAULT 0, -- 0 member / 1 admin / 2 owner
    joined_at   INTEGER NOT NULL,
    muted_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cid, uid)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_uid ON conv_members (uid);

-- seq allocator state; range allocation via UPDATE ... RETURNING (MsgWriter.AllocateSeq)
CREATE TABLE IF NOT EXISTS conv_seq (
    cid      INTEGER PRIMARY KEY,
    next_seq INTEGER NOT NULL DEFAULT 1
);
