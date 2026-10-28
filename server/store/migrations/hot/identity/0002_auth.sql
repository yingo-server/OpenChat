-- identity domain (hot, SQLite). 0002: authentication tables (authsvc).
--
-- ADD-ONLY migration: 0001 is already applied in existing databases and its
-- checksum is verified by the runner, so it must never be edited. This file
-- only creates the new tables the authentication service needs.
--
-- PII note (docs/security-spec.md §5.3):
--   identity_identities.id_value stores ONLY the HMAC-SHA256 index value of a
--   normalized identifier (phone / email / username / guest device). The raw
--   identifier is never written to this database: there is no reversible
--   (phone_enc / email_enc) column in the current schema, and this batch does
--   NOT fake one. Anything that truly needs the plaintext (re-sending an SMS,
--   showing the number) must take it from the live request. At-rest encryption
--   of displayable PII is deferred to the LUKS full-disk baseline
--   (security-spec §5.1 / §5.3), which is the documented fallback when no
--   dedicated pii_key is provisioned.
--
-- identity_identities.id_type enum used by authsvc:
--   1 phone   2 email   3 username   4 guest device

-- OTP / magic-link challenges. code_hash is HMAC-SHA256(otp_key,
-- challenge_id || code) — a 6 digit code is too small a space for a bare hash
-- to be meaningful, so it is keyed and the row is short-lived, single-use and
-- attempt-limited. subject is the same HMAC index value as identity_identities
-- (never the phone number or email).
CREATE TABLE IF NOT EXISTS identity_otp (
    challenge_id TEXT    PRIMARY KEY,          -- public random 128-bit id (hex)
    id_type      INTEGER NOT NULL,
    subject      TEXT    NOT NULL,             -- HMAC index value (no PII)
    code_hash    TEXT    NOT NULL,             -- HMAC(otp_key, challenge_id||code)
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    consumed_at  INTEGER NOT NULL DEFAULT 0,   -- 0 = unused (single use)
    revoked      INTEGER NOT NULL DEFAULT 0,   -- 1 = invalidated (too many tries)
    ip_hash      TEXT    NOT NULL DEFAULT '',  -- HMAC index of the request IP
    device_id    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_identity_otp_subject ON identity_otp (id_type, subject, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_otp_ip ON identity_otp (ip_hash, created_at);

-- Refresh token family (security-spec §2.2). One row per issued refresh token;
-- family_id groups the rotation chain of a single login (one device). The token
-- itself is stored only as SHA-256 hex. rotated_to implements replay detection:
-- a token that was already rotated and is presented again means "family is
-- compromised" -> revoke the whole family.
CREATE TABLE IF NOT EXISTS identity_refresh (
    jti           TEXT    PRIMARY KEY,          -- JWT id (128-bit random)
    family_id     TEXT    NOT NULL,             -- rotation chain / login session
    uid           INTEGER NOT NULL,
    device_id     TEXT    NOT NULL,
    token_hash    TEXT    NOT NULL,             -- SHA-256(token) hex
    issued_at     INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    rotated_to    TEXT,                         -- jti of the successor (NULL = current)
    rotated_at    INTEGER,
    revoked       INTEGER NOT NULL DEFAULT 0,
    revoked_at    INTEGER,
    revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_identity_refresh_family ON identity_refresh (family_id);
CREATE INDEX IF NOT EXISTS idx_identity_refresh_uid ON identity_refresh (uid);

-- Password credentials (security-spec §2.4: argon2id, parameters live in code
-- via core/authn). Kept out of identity_identities on purpose: that table is a
-- pure (id_type,id_value) -> uid index and must stay free of secrets.
CREATE TABLE IF NOT EXISTS identity_credentials (
    uid           INTEGER PRIMARY KEY,
    password_hash TEXT    NOT NULL,             -- PHC string: $argon2id$v=19$...
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (uid) REFERENCES identity_users (uid)
);
