-- Devices table for tracking multi-device support per user
CREATE TABLE user_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label    TEXT,                     -- "iPhone 15", "Chrome on Mac"
    identity_key    BYTEA NOT NULL,          -- Device-level Ed25519 public key (32 bytes)
    webauthn_cred   JSONB,                   -- WebAuthn credential data (id, public_key, attestation)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, identity_key)
);

-- Indexes for efficient lookups
CREATE INDEX idx_devices_user ON user_devices(user_id);
CREATE INDEX idx_devices_last_seen ON user_devices(user_id, last_seen_at DESC);
