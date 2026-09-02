-- PQXDH pre-key bundles for initial key exchange
CREATE TABLE device_pre_keys (
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

CREATE INDEX idx_prekeys_device ON device_pre_keys(device_id);

-- One-time keys for PQXDH
CREATE TABLE device_one_time_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    key_id          INTEGER NOT NULL,
    public_key      BYTEA NOT NULL,           -- Curve25519 one-time pre-key (32 bytes)
    is_consumed     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(device_id, key_id)
);

-- Index for finding available one-time keys
CREATE INDEX idx_otk_available ON device_one_time_keys(device_id, is_consumed)
    WHERE NOT is_consumed;
