package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

type User struct {
	ID          uuid.UUID
	DisplayName string
	IdentityKey []byte
	CreatedAt   time.Time
}

type Device struct {
	ID           uuid.UUID
	UserID       uuid.UUID
	IdentityKey  []byte
	Label        string
	WebauthnCred []byte
	LastSeenAt   time.Time
	CreatedAt    time.Time
}

type OneTimeKey struct {
	ID         uuid.UUID
	DeviceID   uuid.UUID
	KeyID      uint32
	PublicKey  []byte
	IsConsumed bool
	CreatedAt  time.Time
}

type PreKeyBundle struct {
	DeviceID     uuid.UUID
	IdentityKey  []byte
	SPK          []byte
	SPKSig       []byte
	SPKID        uint32
	PQPK         []byte
	PQPKSig      []byte
	PQPKID       uint32
	OneTimeKeyID *uint32
	OneTimeKey   []byte
}

type AuthSession struct {
	ID               uuid.UUID
	UserID           uuid.UUID
	DeviceID         uuid.UUID
	RefreshTokenHash []byte
	ExpiresAt        time.Time
	CreatedAt        time.Time
	RevokedAt        *time.Time
}

type Ceremony struct {
	SessionID    string
	CeremonyType string
	SessionData  []byte
	UserID       []byte
	DisplayName  string
	ExpiresAt    time.Time
}

func (s *PostgresStore) CreateUser(ctx context.Context, displayName string, identityKey []byte) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, 
		`INSERT INTO users (id, display_name, identity_key, created_at) 
		 VALUES ($1, $2, $3, $4) RETURNING id`, 
		uuid.New(), displayName, identityKey, time.Now()).Scan(&id)
	return id, err
}

func (s *PostgresStore) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	u := &User{}
	err := s.pool.QueryRow(ctx, `SELECT id, display_name, identity_key, created_at FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.DisplayName, &u.IdentityKey, &u.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("get user by id failed: %w", err)
	}
	return u, nil
}

func (s *PostgresStore) GetUserByIdentityKey(ctx context.Context, key []byte) (*User, error) {
	u := &User{}
	err := s.pool.QueryRow(ctx, `SELECT id, display_name, identity_key, created_at FROM users WHERE identity_key = $1`, key).
		Scan(&u.ID, &u.DisplayName, &u.IdentityKey, &u.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("get user by identity key failed: %w", err)
	}
	return u, nil
}

func (s *PostgresStore) ListUsers(ctx context.Context, limit int) ([]*User, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT id, display_name, identity_key, created_at FROM users ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list users query failed: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.DisplayName, &u.IdentityKey, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan user row failed: %w", err)
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *PostgresStore) CreateDevice(ctx context.Context, userID uuid.UUID, identityKey []byte, label string, webauthnCred []byte) (uuid.UUID, error) {
	var id uuid.UUID
	now := time.Now()
	err := s.pool.QueryRow(ctx, 
		`INSERT INTO user_devices (id, user_id, identity_key, device_label, webauthn_cred, last_seen_at, created_at) 
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, 
		uuid.New(), userID, identityKey, label, webauthnCred, now, now).Scan(&id)
	return id, err
}

func (s *PostgresStore) GetDevicesByUser(ctx context.Context, userID uuid.UUID) ([]*Device, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, user_id, identity_key, device_label, webauthn_cred, last_seen_at, created_at FROM user_devices WHERE user_id = $1`, userID)
	if err != nil {
		return nil, fmt.Errorf("get devices failed: %w", err)
	}
	defer rows.Close()

	var devices []*Device
	for rows.Next() {
		d := &Device{}
		if err := rows.Scan(&d.ID, &d.UserID, &d.IdentityKey, &d.Label, &d.WebauthnCred, &d.LastSeenAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (s *PostgresStore) GetDeviceByID(ctx context.Context, id uuid.UUID) (*Device, error) {
	d := &Device{}
	err := s.pool.QueryRow(ctx, `SELECT id, user_id, identity_key, device_label, webauthn_cred, last_seen_at, created_at FROM user_devices WHERE id = $1`, id).
		Scan(&d.ID, &d.UserID, &d.IdentityKey, &d.Label, &d.WebauthnCred, &d.LastSeenAt, &d.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("get device by id failed: %w", err)
	}
	return d, nil
}

func (s *PostgresStore) UpdateDeviceLastSeen(ctx context.Context, deviceID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE user_devices SET last_seen_at = $1 WHERE id = $2`, time.Now(), deviceID)
	return err
}

func (s *PostgresStore) UploadPreKeyBundle(ctx context.Context, deviceID uuid.UUID, spk, spkSig []byte, spkID uint32, pqpk, pqpkSig []byte, pqpkID uint32) error {
	_, err := s.pool.Exec(ctx, 
		`INSERT INTO device_pre_keys (device_id, signed_pre_key, signed_pre_key_sig, signed_pre_key_id, pq_pre_key, pq_pre_key_sig, pq_pre_key_id, uploaded_at) 
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (device_id, signed_pre_key_id) DO UPDATE SET 
		 signed_pre_key = EXCLUDED.signed_pre_key, signed_pre_key_sig = EXCLUDED.signed_pre_key_sig,
		 pq_pre_key = EXCLUDED.pq_pre_key, pq_pre_key_sig = EXCLUDED.pq_pre_key_sig, pq_pre_key_id = EXCLUDED.pq_pre_key_id,
		 uploaded_at = EXCLUDED.uploaded_at`,
		deviceID, spk, spkSig, spkID, pqpk, pqpkSig, pqpkID, time.Now())
	return err
}

type OTK struct {
	KeyID     uint32
	PublicKey []byte
}

func (s *PostgresStore) UploadOneTimeKeys(ctx context.Context, deviceID uuid.UUID, keys []OTK) error {
	batch := &pgx.Batch{}
	now := time.Now()
	for _, k := range keys {
		batch.Queue(`INSERT INTO device_one_time_keys (id, device_id, key_id, public_key, is_consumed, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			uuid.New(), deviceID, k.KeyID, k.PublicKey, false, now)
	}
	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < len(keys); i++ {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("failed to insert otk %d: %w", i, err)
		}
	}
	return nil
}

func (s *PostgresStore) FetchPreKeyBundle(ctx context.Context, userID, deviceID uuid.UUID) (*PreKeyBundle, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var bundle PreKeyBundle
	bundle.DeviceID = deviceID

	err = tx.QueryRow(ctx, `SELECT identity_key FROM user_devices WHERE id = $1`, deviceID).Scan(&bundle.IdentityKey)
	if err != nil {
		return nil, fmt.Errorf("failed to get identity key: %w", err)
	}

	err = tx.QueryRow(ctx, `SELECT signed_pre_key, signed_pre_key_sig, signed_pre_key_id, pq_pre_key, pq_pre_key_sig, pq_pre_key_id FROM device_pre_keys WHERE device_id = $1 ORDER BY uploaded_at DESC LIMIT 1`, deviceID).
		Scan(&bundle.SPK, &bundle.SPKSig, &bundle.SPKID, &bundle.PQPK, &bundle.PQPKSig, &bundle.PQPKID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pre keys: %w", err)
	}

	var otkID uint32
	var otkData []byte
	err = tx.QueryRow(ctx, `
		UPDATE device_one_time_keys 
		SET is_consumed = true 
		WHERE id = (
			SELECT id FROM device_one_time_keys 
			WHERE device_id = $1 AND is_consumed = false 
			LIMIT 1 FOR UPDATE SKIP LOCKED
		) RETURNING key_id, public_key`, deviceID).Scan(&otkID, &otkData)
	
	if err == nil {
		bundle.OneTimeKeyID = &otkID
		bundle.OneTimeKey = otkData
	} else if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("failed to fetch and consume otk: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit tx: %w", err)
	}

	return &bundle, nil
}

func (s *PostgresStore) GetOneTimeKeyCount(ctx context.Context, deviceID uuid.UUID) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM device_one_time_keys WHERE device_id = $1 AND is_consumed = false`, deviceID).Scan(&count)
	return count, err
}

func (s *PostgresStore) CreateAuthSession(ctx context.Context, userID, deviceID uuid.UUID, refreshTokenHash []byte, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, 
		`INSERT INTO auth_sessions (id, user_id, device_id, refresh_token_hash, expires_at, created_at) 
		 VALUES ($1, $2, $3, $4, $5, $6)`, 
		uuid.New(), userID, deviceID, refreshTokenHash, expiresAt, time.Now())
	return err
}

func (s *PostgresStore) GetAuthSession(ctx context.Context, refreshTokenHash []byte) (*AuthSession, error) {
	sess := &AuthSession{}
	err := s.pool.QueryRow(ctx, 
		`SELECT id, user_id, device_id, refresh_token_hash, expires_at, created_at, revoked_at 
		 FROM auth_sessions WHERE refresh_token_hash = $1`, refreshTokenHash).
		Scan(&sess.ID, &sess.UserID, &sess.DeviceID, &sess.RefreshTokenHash, &sess.ExpiresAt, &sess.CreatedAt, &sess.RevokedAt)
	if err != nil {
		return nil, err
	}
	return sess, nil
}

func (s *PostgresStore) RevokeAuthSession(ctx context.Context, sessionID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE auth_sessions SET revoked_at = $1 WHERE id = $2`, time.Now(), sessionID)
	return err
}

func (s *PostgresStore) SaveCeremony(ctx context.Context, sessionID, ceremonyType string, sessionData, userID []byte, displayName string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, 
		`INSERT INTO webauthn_ceremonies (session_id, ceremony_type, session_data, user_id, display_name, expires_at) 
		 VALUES ($1, $2, $3, $4, $5, $6)`, 
		sessionID, ceremonyType, sessionData, userID, displayName, expiresAt)
	return err
}

func (s *PostgresStore) GetCeremony(ctx context.Context, sessionID string) (*Ceremony, error) {
	c := &Ceremony{}
	err := s.pool.QueryRow(ctx, 
		`SELECT session_id, ceremony_type, session_data, user_id, display_name, expires_at 
		 FROM webauthn_ceremonies WHERE session_id = $1`, sessionID).
		Scan(&c.SessionID, &c.CeremonyType, &c.SessionData, &c.UserID, &c.DisplayName, &c.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return c, nil
}

func (s *PostgresStore) DeleteCeremony(ctx context.Context, sessionID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM webauthn_ceremonies WHERE session_id = $1`, sessionID)
	return err
}

// ============================================================
// Channel & Push Token Management (Phase 2)
// ============================================================

type Channel struct {
	ID          uuid.UUID
	ChannelType string
	Name        string
	CreatorID   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type ChannelMember struct {
	ChannelID   uuid.UUID
	UserID      uuid.UUID
	Role        string
	JoinedAt    time.Time
	LastReadSeq int64
}

type PushToken struct {
	DeviceID  uuid.UUID
	UserID    uuid.UUID
	Platform  string
	Token     string
	Endpoint  string
	P256dh    []byte
	Auth      []byte
	UpdatedAt time.Time
}

func (s *PostgresStore) CreateChannel(ctx context.Context, channelType, name string, creatorID *uuid.UUID, memberIDs []uuid.UUID) (*Channel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	ch := &Channel{
		ID:          uuid.New(),
		ChannelType: channelType,
		Name:        name,
		CreatorID:   creatorID,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO channels (id, channel_type, name, creator_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		ch.ID, ch.ChannelType, ch.Name, ch.CreatorID, ch.CreatedAt, ch.UpdatedAt)
	if err != nil {
		return nil, err
	}

	for _, uid := range memberIDs {
		role := "member"
		if creatorID != nil && uid == *creatorID {
			role = "owner"
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id, role, joined_at, last_read_seq)
			 VALUES ($1, $2, $3, $4, 0)
			 ON CONFLICT (channel_id, user_id) DO NOTHING`,
			ch.ID, uid, role, time.Now())
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return ch, nil
}

func (s *PostgresStore) GetChannelMembers(ctx context.Context, channelID uuid.UUID) ([]ChannelMember, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT channel_id, user_id, role, joined_at, last_read_seq
		 FROM channel_members
		 WHERE channel_id = $1 AND left_at IS NULL`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []ChannelMember
	for rows.Next() {
		var m ChannelMember
		if err := rows.Scan(&m.ChannelID, &m.UserID, &m.Role, &m.JoinedAt, &m.LastReadSeq); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, nil
}

func (s *PostgresStore) ListUserChannels(ctx context.Context, userID uuid.UUID, limit int) ([]Channel, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx,
		`SELECT c.id, c.channel_type, c.name, c.creator_id, c.created_at, c.updated_at
		 FROM channels c
		 JOIN channel_members m ON c.id = m.channel_id
		 WHERE m.user_id = $1 AND m.left_at IS NULL
		 ORDER BY c.updated_at DESC
		 LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []Channel
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.ChannelType, &c.Name, &c.CreatorID, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		channels = append(channels, c)
	}
	return channels, nil
}

func (s *PostgresStore) GetChannel(ctx context.Context, channelID uuid.UUID) (*Channel, error) {
	var c Channel
	err := s.pool.QueryRow(ctx,
		`SELECT id, channel_type, name, creator_id, created_at, updated_at
		 FROM channels WHERE id = $1`, channelID).
		Scan(&c.ID, &c.ChannelType, &c.Name, &c.CreatorID, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *PostgresStore) JoinChannel(ctx context.Context, channelID, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id, role, joined_at, last_read_seq)
		 VALUES ($1, $2, 'member', now(), 0)
		 ON CONFLICT (channel_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now()`,
		channelID, userID)
	return err
}

func (s *PostgresStore) LeaveChannel(ctx context.Context, channelID, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE channel_members SET left_at = now() WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID)
	return err
}

func (s *PostgresStore) IsChannelMember(ctx context.Context, channelID, userID uuid.UUID) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM channel_members
			WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL
		)`, channelID, userID).Scan(&exists)
	return exists, err
}



func (s *PostgresStore) GetRemainingOneTimeKeyCount(ctx context.Context, deviceID uuid.UUID) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM device_one_time_keys
		 WHERE device_id = $1 AND NOT is_consumed`, deviceID).Scan(&count)
	return count, err
}

func (s *PostgresStore) RegisterPushToken(ctx context.Context, pt *PushToken) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO device_push_tokens (device_id, user_id, platform, token, endpoint, p256dh, auth, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (device_id) DO UPDATE SET
		   platform = EXCLUDED.platform,
		   token = EXCLUDED.token,
		   endpoint = EXCLUDED.endpoint,
		   p256dh = EXCLUDED.p256dh,
		   auth = EXCLUDED.auth,
		   updated_at = EXCLUDED.updated_at`,
		pt.DeviceID, pt.UserID, pt.Platform, pt.Token, pt.Endpoint, pt.P256dh, pt.Auth, time.Now())
	return err
}

func (s *PostgresStore) GetPushTokensForUser(ctx context.Context, userID uuid.UUID) ([]PushToken, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT device_id, user_id, platform, token, endpoint, p256dh, auth, updated_at
		 FROM device_push_tokens WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []PushToken
	for rows.Next() {
		var t PushToken
		if err := rows.Scan(&t.DeviceID, &t.UserID, &t.Platform, &t.Token, &t.Endpoint, &t.P256dh, &t.Auth, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	return tokens, nil
}

func (s *PostgresStore) UnregisterPushToken(ctx context.Context, deviceID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM device_push_tokens WHERE device_id = $1`, deviceID)
	return err
}

func (s *PostgresStore) EnsureDevUserAndDevice(ctx context.Context, userID, deviceID uuid.UUID, displayName string) error {
	if displayName == "" {
		displayName = "Dev User"
	}
	userIdentKey := sha256.Sum256([]byte("user:" + userID.String()))
	deviceIdentKey := sha256.Sum256([]byte("device:" + deviceID.String()))

	now := time.Now()
	_, err := s.pool.Exec(ctx,
		`INSERT INTO users (id, display_name, identity_key, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $4)
		 ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
		userID, displayName, userIdentKey[:], now,
	)
	if err != nil {
		return fmt.Errorf("ensure dev user failed: %w", err)
	}

	_, err = s.pool.Exec(ctx,
		`INSERT INTO user_devices (id, user_id, identity_key, device_label, last_seen_at, created_at)
		 VALUES ($1, $2, $3, 'Dev Device', $4, $4)
		 ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
		deviceID, userID, deviceIdentKey[:], now,
	)
	if err != nil {
		return fmt.Errorf("ensure dev device failed: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------
// MLS (Messaging Layer Security) Storage Methods
// ---------------------------------------------------------------------

func (s *PostgresStore) SaveMlsKeyPackage(ctx context.Context, userID, deviceID uuid.UUID, keyPackage []byte) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO user_mls_key_packages (id, user_id, device_id, key_package, is_consumed, created_at)
		 VALUES ($1, $2, $3, $4, false, now())`,
		uuid.New(), userID, deviceID, keyPackage,
	)
	if err != nil {
		return fmt.Errorf("save mls key package failed: %w", err)
	}
	return nil
}

func (s *PostgresStore) GetActiveMlsKeyPackage(ctx context.Context, userID uuid.UUID, deviceID *uuid.UUID) ([]byte, error) {
	var kp []byte
	var err error
	if deviceID != nil && *deviceID != uuid.Nil {
		err = s.pool.QueryRow(ctx,
			`SELECT key_package FROM user_mls_key_packages
			 WHERE user_id = $1 AND device_id = $2 AND is_consumed = false
			 ORDER BY created_at DESC LIMIT 1`,
			userID, *deviceID,
		).Scan(&kp)
	} else {
		err = s.pool.QueryRow(ctx,
			`SELECT key_package FROM user_mls_key_packages
			 WHERE user_id = $1 AND is_consumed = false
			 ORDER BY created_at DESC LIMIT 1`,
			userID,
		).Scan(&kp)
	}
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("no active mls key package found for user %s", userID)
		}
		return nil, fmt.Errorf("get active mls key package failed: %w", err)
	}
	return kp, nil
}

func (s *PostgresStore) SaveMlsWelcome(ctx context.Context, channelID, userID uuid.UUID, epoch uint64, welcomeData []byte) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO channel_mls_welcomes (id, channel_id, user_id, welcome_data, epoch, created_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (channel_id, user_id, epoch) DO UPDATE SET welcome_data = EXCLUDED.welcome_data`,
		uuid.New(), channelID, userID, welcomeData, epoch,
	)
	if err != nil {
		return fmt.Errorf("save mls welcome failed: %w", err)
	}
	return nil
}

func (s *PostgresStore) GetMlsWelcome(ctx context.Context, channelID, userID uuid.UUID) ([]byte, uint64, error) {
	var welcome []byte
	var epoch int64
	err := s.pool.QueryRow(ctx,
		`SELECT welcome_data, epoch FROM channel_mls_welcomes
		 WHERE channel_id = $1 AND user_id = $2
		 ORDER BY epoch DESC, created_at DESC LIMIT 1`,
		channelID, userID,
	).Scan(&welcome, &epoch)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, 0, nil // No welcome stored yet
		}
		return nil, 0, fmt.Errorf("get mls welcome failed: %w", err)
	}
	return welcome, uint64(epoch), nil
}

func (s *PostgresStore) SaveMlsCommit(ctx context.Context, channelID, senderID uuid.UUID, epoch uint64, commitData []byte) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO channel_mls_commits (id, channel_id, sender_id, epoch, commit_data, created_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (channel_id, epoch) DO UPDATE SET commit_data = EXCLUDED.commit_data`,
		uuid.New(), channelID, senderID, epoch, commitData,
	)
	if err != nil {
		return fmt.Errorf("save mls commit failed: %w", err)
	}
	return nil
}

func (s *PostgresStore) GetLatestMlsCommit(ctx context.Context, channelID uuid.UUID) ([]byte, uint64, error) {
	var commit []byte
	var epoch int64
	err := s.pool.QueryRow(ctx,
		`SELECT commit_data, epoch FROM channel_mls_commits
		 WHERE channel_id = $1
		 ORDER BY epoch DESC LIMIT 1`,
		channelID,
	).Scan(&commit, &epoch)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, 0, nil
		}
		return nil, 0, fmt.Errorf("get latest mls commit failed: %w", err)
	}
	return commit, uint64(epoch), nil
}



