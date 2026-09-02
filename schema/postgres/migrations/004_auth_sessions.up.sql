-- Auth session tracking
CREATE TABLE auth_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    device_id       UUID REFERENCES user_devices(id) ON DELETE CASCADE,
    refresh_token_hash BYTEA NOT NULL,       -- SHA-256 hash of refresh token
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_refresh ON auth_sessions(refresh_token_hash) WHERE revoked_at IS NULL;

-- WebAuthn ceremony state (short-lived)
CREATE TABLE webauthn_ceremonies (
    session_id      TEXT PRIMARY KEY,
    ceremony_type   TEXT NOT NULL CHECK (ceremony_type IN ('registration', 'login')),
    session_data    JSONB NOT NULL,          -- Serialized WebAuthn session data
    user_id         UUID REFERENCES users(id),
    display_name    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_ceremonies_expiry ON webauthn_ceremonies(expires_at);

-- Blind token spent set to prevent replay attacks
CREATE TABLE spent_blind_tokens (
    token_hash      BYTEA PRIMARY KEY,
    redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
