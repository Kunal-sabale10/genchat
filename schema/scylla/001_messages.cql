-- Keyspace for GenChat
CREATE KEYSPACE IF NOT EXISTS genchat
WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
};

-- Messages table designed for efficient retrieval by conversation
-- Uses TimeWindowCompactionStrategy suitable for time-series message data
CREATE TABLE IF NOT EXISTS genchat.messages (
    conversation_id TEXT,
    bucket          TEXT, -- Time-based bucket for partition size bounding
    message_id      TIMEUUID,
    sequence_num    BIGINT,
    sender_id       TEXT,
    client_msg_id   TEXT,
    encrypted_payload BLOB,
    sender_ratchet_key BLOB,
    message_index   INT,
    created_at      TIMESTAMP,
    PRIMARY KEY ((conversation_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': '1'
}
AND default_time_to_live = 0
AND gc_grace_seconds = 86400;

-- Client deduplication table to prevent replay of the same client message
CREATE TABLE IF NOT EXISTS genchat.client_dedup (
    conversation_id TEXT,
    client_msg_id   TEXT,
    message_id      TIMEUUID,
    created_at      TIMESTAMP,
    PRIMARY KEY ((conversation_id), client_msg_id)
) WITH default_time_to_live = 86400;

-- Track message delivery and read receipts for users in conversations
CREATE TABLE IF NOT EXISTS genchat.message_receipts (
    conversation_id      TEXT,
    user_id              TEXT,
    last_delivered_id    TIMEUUID,
    last_delivered_seq   BIGINT,
    last_read_id         TIMEUUID,
    last_read_seq        BIGINT,
    updated_at           TIMESTAMP,
    PRIMARY KEY ((conversation_id), user_id)
);

-- Conversations table to map users to their ongoing conversations
CREATE TABLE IF NOT EXISTS genchat.conversations (
    conversation_id TEXT,
    participant_id  TEXT,
    other_user_id   TEXT,
    created_at      TIMESTAMP,
    PRIMARY KEY ((participant_id), conversation_id)
);

-- Channel and Group Messages (MLS encrypted)
CREATE TABLE IF NOT EXISTS genchat.channel_messages (
    channel_id      TEXT,
    bucket          TEXT, -- Time bucket (e.g., YYYY-MM-DD)
    message_id      TIMEUUID,
    sequence_num    BIGINT,
    sender_id       TEXT,
    device_id       TEXT,
    epoch           BIGINT,
    encrypted_payload BLOB, -- MLS application message ciphertext
    created_at      TIMESTAMP,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': '1'
}
AND default_time_to_live = 0
AND gc_grace_seconds = 86400;

-- MLS Commit Log for group epoch synchronization
CREATE TABLE IF NOT EXISTS genchat.mls_commit_log (
    channel_id      TEXT,
    epoch           BIGINT,
    commit_id       TIMEUUID,
    sender_id       TEXT,
    commit_payload  BLOB, -- Serialized MLS Commit packet
    created_at      TIMESTAMP,
    PRIMARY KEY ((channel_id), epoch)
) WITH CLUSTERING ORDER BY (epoch DESC);
