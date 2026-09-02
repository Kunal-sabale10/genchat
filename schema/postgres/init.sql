-- GenChat PostgreSQL Schema Initializer
-- Auto-generated from migrations 001-005

-- 001: Users table
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name    TEXT NOT NULL,
    identity_key    BYTEA NOT NULL,          -- Ed25519 public key (32 bytes)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identity_key ON users(identity_key);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 002: Devices table
CREATE TABLE IF NOT EXISTS user_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label    TEXT,                     -- "iPhone 15", "Chrome on Mac"
    identity_key    BYTEA NOT NULL,          -- Device-level Ed25519 public key (32 bytes)
    webauthn_cred   JSONB,                   -- WebAuthn credential data (id, public_key, attestation)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON user_devices(user_id, last_seen_at DESC);

-- 003: Prekeys tables
CREATE TABLE IF NOT EXISTS device_pre_keys (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id             UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    signed_pre_key        BYTEA NOT NULL,      -- Curve25519 public key (32 bytes)
    signed_pre_key_sig    BYTEA NOT NULL,      -- Ed25519 signature over SPK (64 bytes)
    signed_pre_key_id     INTEGER NOT NULL,
    pq_pre_key            BYTEA NOT NULL,      -- ML-KEM-768 encapsulation key (1184 bytes)
    pq_pre_key_sig        BYTEA NOT NULL,      -- Ed25519 signature over PQPK (64 bytes)
    pq_pre_key_id         INTEGER NOT NULL,
    uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at            TIMESTAMPTZ,
    UNIQUE(device_id, signed_pre_key_id)
);

CREATE INDEX IF NOT EXISTS idx_prekeys_device ON device_pre_keys(device_id);

CREATE TABLE IF NOT EXISTS device_one_time_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    key_id          INTEGER NOT NULL,
    public_key      BYTEA NOT NULL,           -- Curve25519 one-time pre-key (32 bytes)
    is_consumed     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(device_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_otk_available ON device_one_time_keys(device_id, is_consumed)
    WHERE NOT is_consumed;

-- 004: Auth sessions, ceremonies, spent tokens
CREATE TABLE IF NOT EXISTS auth_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    device_id       UUID REFERENCES user_devices(id) ON DELETE CASCADE,
    refresh_token_hash BYTEA NOT NULL,       -- SHA-256 hash of refresh token
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON auth_sessions(refresh_token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webauthn_ceremonies (
    session_id      TEXT PRIMARY KEY,
    ceremony_type   TEXT NOT NULL CHECK (ceremony_type IN ('registration', 'login')),
    session_data    JSONB NOT NULL,          -- Serialized WebAuthn session data
    user_id         UUID REFERENCES users(id),
    display_name    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ceremonies_expiry ON webauthn_ceremonies(expires_at);

CREATE TABLE IF NOT EXISTS spent_blind_tokens (
    token_hash      BYTEA PRIMARY KEY,
    redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 005: Channels, Group members, Push tokens
CREATE TABLE IF NOT EXISTS channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_type    VARCHAR(16) NOT NULL CHECK (channel_type IN ('dm', 'group', 'broadcast')),
    name            TEXT,
    creator_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(channel_type);
CREATE INDEX IF NOT EXISTS idx_channels_creator ON channels(creator_id);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at         TIMESTAMPTZ,
    last_read_seq   BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS device_push_tokens (
    device_id       UUID PRIMARY KEY REFERENCES user_devices(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform        VARCHAR(16) NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush')),
    token           TEXT NOT NULL,
    endpoint        TEXT,
    p256dh          BYTEA,
    auth            BYTEA,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON device_push_tokens(user_id);
