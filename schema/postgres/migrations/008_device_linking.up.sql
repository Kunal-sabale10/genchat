-- 008: Multi-Device Linking Sessions
CREATE TABLE IF NOT EXISTS device_linking_sessions (
    session_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    primary_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    primary_device_id UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    ephemeral_pubkey  BYTEA NOT NULL,
    auth_code_hash    BYTEA NOT NULL,
    encrypted_bundle  BYTEA,
    new_device_id     UUID,
    status            VARCHAR(32) NOT NULL DEFAULT 'pending',
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_linking_user ON device_linking_sessions(primary_user_id);
CREATE INDEX IF NOT EXISTS idx_device_linking_expiry ON device_linking_sessions(expires_at);
