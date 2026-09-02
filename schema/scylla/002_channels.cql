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
