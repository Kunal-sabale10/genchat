-- 010_gdpr_group_cascade.up.sql
-- Preserve collective MLS group commit logs when a user exercises right-to-erasure.
-- This ensures remaining group members can still verify and synchronize historical MLS epochs.

ALTER TABLE channel_mls_commits ALTER COLUMN sender_id DROP NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'channel_mls_commits_sender_id_fkey'
    ) THEN
        ALTER TABLE channel_mls_commits DROP CONSTRAINT channel_mls_commits_sender_id_fkey;
    END IF;
END $$;

ALTER TABLE channel_mls_commits 
    ADD CONSTRAINT channel_mls_commits_sender_id_fkey 
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL;
