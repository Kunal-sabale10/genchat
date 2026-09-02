-- Channels and Group Messaging Schema

-- Channels table for 1:1 DMs, group chats, and broadcast channels
CREATE TABLE IF NOT EXISTS channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_type    VARCHAR(16) NOT NULL CHECK (channel_type IN ('dm', 'group', 'broadcast')),
    name            TEXT,                                      -- NULL for 1:1 DMs, group name for groups
    creator_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(channel_type);
CREATE INDEX IF NOT EXISTS idx_channels_creator ON channels(creator_id);

-- Channel members tracking membership, roles, and read states
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

-- Device push tokens for APNs, FCM, and WebPush background notifications
CREATE TABLE IF NOT EXISTS device_push_tokens (
    device_id       UUID PRIMARY KEY REFERENCES user_devices(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform        VARCHAR(16) NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush')),
    token           TEXT NOT NULL,
    endpoint        TEXT,                                      -- For WebPush
    p256dh          BYTEA,                                     -- For WebPush P-256 public key
    auth            BYTEA,                                     -- For WebPush auth secret
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON device_push_tokens(user_id);
