-- 009: User Blocking and E2EE Voluntary Abuse Reporting
CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS abuse_reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id   TEXT NOT NULL,
    message_id        TEXT,
    reason            TEXT NOT NULL,
    decrypted_content TEXT,
    raw_ciphertext    BYTEA,
    status            VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports(status);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_reported ON abuse_reports(reported_id);
