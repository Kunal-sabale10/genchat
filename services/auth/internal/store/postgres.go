package store

import (
	"context"
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

	err = tx.QueryRow(ctx, `SELECT signed_pre_key, signed_pre_key_sig, signed_pre_key_id, pq_pre_key, pq_pre_key_sig, pq_pre_key_id FROM device_pre_keys WHERE device_id = $1`, deviceID).
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
