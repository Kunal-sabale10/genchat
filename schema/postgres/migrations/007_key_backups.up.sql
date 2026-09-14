-- 007: Encrypted Key/Account Backup table
CREATE TABLE IF NOT EXISTS user_key_backups (
    user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    backup_ciphertext BYTEA NOT NULL,
    kdf_salt          BYTEA NOT NULL,
    kdf_algorithm     TEXT NOT NULL DEFAULT 'argon2id',
    kdf_params        JSONB NOT NULL,
    bundle_version    INTEGER NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_key_backups_user ON user_key_backups(user_id);
