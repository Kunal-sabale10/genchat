package handler

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/auth/internal/store"
)

// mockAuthStore implements the AuthStore interface for hermetic security unit testing.
type mockAuthStore struct {
	devices map[uuid.UUID]*store.Device
	users   map[uuid.UUID]*store.User
	prekeys map[uuid.UUID]*store.PreKeyBundle
}

func newMockAuthStore() *mockAuthStore {
	return &mockAuthStore{
		devices: make(map[uuid.UUID]*store.Device),
		users:   make(map[uuid.UUID]*store.User),
		prekeys: make(map[uuid.UUID]*store.PreKeyBundle),
	}
}

func (m *mockAuthStore) CreateUser(ctx context.Context, displayName string, identityKey []byte) (uuid.UUID, error) {
	id := uuid.New()
	m.users[id] = &store.User{ID: id, DisplayName: displayName, IdentityKey: identityKey}
	return id, nil
}

func (m *mockAuthStore) GetUserByID(ctx context.Context, id uuid.UUID) (*store.User, error) {
	if u, ok := m.users[id]; ok {
		return u, nil
	}
	return nil, status.Errorf(codes.NotFound, "user not found")
}

func (m *mockAuthStore) GetUserByIdentityKey(ctx context.Context, key []byte) (*store.User, error) {
	return nil, status.Errorf(codes.NotFound, "not implemented")
}

func (m *mockAuthStore) ListUsers(ctx context.Context, limit int) ([]*store.User, error) {
	var list []*store.User
	for _, u := range m.users {
		list = append(list, u)
	}
	return list, nil
}

func (m *mockAuthStore) CreateDevice(ctx context.Context, userID uuid.UUID, identityKey []byte, label string, webauthnCred []byte) (uuid.UUID, error) {
	id := uuid.New()
	m.devices[id] = &store.Device{ID: id, UserID: userID, IdentityKey: identityKey, Label: label}
	return id, nil
}

func (m *mockAuthStore) GetDeviceByID(ctx context.Context, id uuid.UUID) (*store.Device, error) {
	if d, ok := m.devices[id]; ok {
		return d, nil
	}
	return nil, status.Errorf(codes.NotFound, "device not found")
}

func (m *mockAuthStore) GetDevicesByUser(ctx context.Context, userID uuid.UUID) ([]*store.Device, error) {
	var list []*store.Device
	for _, d := range m.devices {
		if d.UserID == userID {
			list = append(list, d)
		}
	}
	return list, nil
}

func (m *mockAuthStore) UpdateDeviceLastSeen(ctx context.Context, deviceID uuid.UUID) error {
	return nil
}

func (m *mockAuthStore) UploadPreKeyBundle(ctx context.Context, deviceID uuid.UUID, spk, spkSig []byte, spkID uint32, pqpk, pqpkSig []byte, pqpkID uint32) error {
	m.prekeys[deviceID] = &store.PreKeyBundle{
		DeviceID: deviceID,
		SPK:      spk,
		SPKSig:   spkSig,
		SPKID:    spkID,
		PQPK:     pqpk,
		PQPKSig:  pqpkSig,
		PQPKID:   pqpkID,
	}
	return nil
}

func (m *mockAuthStore) UploadOneTimeKeys(ctx context.Context, deviceID uuid.UUID, keys []store.OTK) error {
	return nil
}

func (m *mockAuthStore) FetchPreKeyBundle(ctx context.Context, userID, deviceID uuid.UUID) (*store.PreKeyBundle, error) {
	if bundle, ok := m.prekeys[deviceID]; ok {
		return bundle, nil
	}
	// Return a stub bundle if registered
	if _, ok := m.devices[deviceID]; ok {
		return &store.PreKeyBundle{
			DeviceID:    deviceID,
			IdentityKey: []byte("mock-identity-key-32-bytes-long!"),
			SPK:         []byte("mock-spk-key-32-bytes-long!!!!!!"),
			SPKSig:      []byte("mock-spk-sig-64-bytes-long-padding-padding-padding-padding-pad!!"),
			SPKID:       1,
		}, nil
	}
	return nil, status.Errorf(codes.NotFound, "pre-key bundle not found")
}

func (m *mockAuthStore) GetRemainingOneTimeKeyCount(ctx context.Context, deviceID uuid.UUID) (int, error) {
	return 25, nil
}

func (m *mockAuthStore) CreateAuthSession(ctx context.Context, userID, deviceID uuid.UUID, refreshTokenHash []byte, expiresAt time.Time) error {
	return nil
}

func (m *mockAuthStore) GetAuthSession(ctx context.Context, refreshTokenHash []byte) (*store.AuthSession, error) {
	return nil, status.Errorf(codes.NotFound, "not implemented")
}

func (m *mockAuthStore) RevokeAuthSession(ctx context.Context, sessionID uuid.UUID) error {
	return nil
}

func (m *mockAuthStore) SaveCeremony(ctx context.Context, sessionID, ceremonyType string, sessionData, userID []byte, displayName string, expiresAt time.Time) error {
	return nil
}

func (m *mockAuthStore) GetCeremony(ctx context.Context, sessionID string) (*store.Ceremony, error) {
	return nil, status.Errorf(codes.NotFound, "not implemented")
}

func (m *mockAuthStore) DeleteCeremony(ctx context.Context, sessionID string) error {
	return nil
}

func (m *mockAuthStore) CreateChannel(ctx context.Context, channelType, name string, creatorID *uuid.UUID, memberIDs []uuid.UUID) (*store.Channel, error) {
	id := uuid.New()
	return &store.Channel{
		ID:          id,
		ChannelType: channelType,
		Name:        name,
		CreatorID:   creatorID,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}, nil
}

func (m *mockAuthStore) JoinChannel(ctx context.Context, channelID, userID uuid.UUID) error {
	return nil
}

func (m *mockAuthStore) LeaveChannel(ctx context.Context, channelID, userID uuid.UUID) error {
	return nil
}

func (m *mockAuthStore) ListUserChannels(ctx context.Context, userID uuid.UUID, limit int) ([]store.Channel, error) {
	return []store.Channel{}, nil
}

func (m *mockAuthStore) GetChannelMembers(ctx context.Context, channelID uuid.UUID) ([]store.ChannelMember, error) {
	return []store.ChannelMember{}, nil
}

func (m *mockAuthStore) RegisterPushToken(ctx context.Context, pt *store.PushToken) error {
	return nil
}

func (m *mockAuthStore) UnregisterPushToken(ctx context.Context, deviceID uuid.UUID) error {
	return nil
}

func (m *mockAuthStore) GetPushTokensForUser(ctx context.Context, userID uuid.UUID) ([]store.PushToken, error) {
	return []store.PushToken{}, nil
}

func (m *mockAuthStore) EnsureDevUserAndDevice(ctx context.Context, userID, deviceID uuid.UUID, displayName string) error {
	m.users[userID] = &store.User{ID: userID, DisplayName: displayName}
	m.devices[deviceID] = &store.Device{ID: deviceID, UserID: userID, Label: "Dev Device"}
	return nil
}

func (m *mockAuthStore) IsChannelMember(ctx context.Context, channelID, userID uuid.UUID) (bool, error) {
	return true, nil
}

func (m *mockAuthStore) SaveMlsKeyPackage(ctx context.Context, userID, deviceID uuid.UUID, keyPackage []byte) error {
	return nil
}

func (m *mockAuthStore) GetActiveMlsKeyPackage(ctx context.Context, userID uuid.UUID, deviceID *uuid.UUID) ([]byte, error) {
	return []byte("mock-mls-key-package"), nil
}

func (m *mockAuthStore) SaveMlsWelcome(ctx context.Context, channelID, userID uuid.UUID, epoch uint64, welcomeData []byte) error {
	return nil
}

func (m *mockAuthStore) GetMlsWelcome(ctx context.Context, channelID, userID uuid.UUID) ([]byte, uint64, error) {
	return nil, 0, nil
}

func (m *mockAuthStore) SaveMlsCommit(ctx context.Context, channelID, senderID uuid.UUID, epoch uint64, commitData []byte) error {
	return nil
}

func (m *mockAuthStore) GetLatestMlsCommit(ctx context.Context, channelID uuid.UUID) ([]byte, uint64, error) {
	return nil, 0, nil
}


// setupTestGRPCServer starts an in-process bufconn gRPC server with the AuthHandler and interceptors.
func setupTestGRPCServer(t *testing.T, jwtSecret string) (*mockAuthStore, *grpc.ClientConn, func()) {
	bufferSize := 1024 * 1024
	lis := bufconn.Listen(bufferSize)

	mockStore := newMockAuthStore()
	h := NewAuthHandler(mockStore, nil, jwtSecret, "turn_secret", "genchat.local", nil, nil)

	s := grpc.NewServer(
		grpc.UnaryInterceptor(h.UnaryAuthInterceptor()),
		grpc.StreamInterceptor(h.StreamAuthInterceptor()),
	)
	chatv1.RegisterChannelServiceServer(s, h)
	chatv1.RegisterKeyServiceServer(s, h)

	go func() {
		if err := s.Serve(lis); err != nil && err != grpc.ErrServerStopped {
			t.Logf("Server error: %v", err)
		}
	}()

	dialer := func(context.Context, string) (net.Conn, error) {
		return lis.Dial()
	}

	conn, err := grpc.DialContext(
		context.Background(),
		"bufnet",
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("Failed to dial bufnet: %v", err)
	}

	cleanup := func() {
		conn.Close()
		s.GracefulStop()
		lis.Close()
	}

	return mockStore, conn, cleanup
}

func TestAuthBypassesAndOwnershipRegression(t *testing.T) {
	jwtSecret := "super-secret-hmac-key-for-test-32b-minimum"
	mockStore, conn, cleanup := setupTestGRPCServer(t, jwtSecret)
	defer cleanup()

	channelClient := chatv1.NewChannelServiceClient(conn)
	keyClient := chatv1.NewKeyServiceClient(conn)

	// Set up User A with Device A
	userA := uuid.New()
	deviceA := uuid.New()
	mockStore.users[userA] = &store.User{ID: userA, DisplayName: "Alice"}
	mockStore.devices[deviceA] = &store.Device{ID: deviceA, UserID: userA, Label: "Alice Phone"}

	// Set up User B with Device B
	userB := uuid.New()
	deviceB := uuid.New()
	mockStore.users[userB] = &store.User{ID: userB, DisplayName: "Bob"}
	mockStore.devices[deviceB] = &store.Device{ID: deviceB, UserID: userB, Label: "Bob Laptop"}

	tokenA := makeTestJWT(jwtSecret, userA.String(), deviceA.String(), 15*time.Minute)
	tokenB := makeTestJWT(jwtSecret, userB.String(), deviceB.String(), 15*time.Minute)

	// Helper for creating incoming context with headers
	authCtx := func(token string) context.Context {
		md := metadata.Pairs("authorization", "Bearer "+token)
		return metadata.NewOutgoingContext(context.Background(), md)
	}

	// -------------------------------------------------------------------------
	// REGRESSION TEST 1: Unauthenticated Calls Must Be Rejected (codes.Unauthenticated)
	// -------------------------------------------------------------------------
	t.Run("CreateChannel without token fails closed (401 Unauthenticated)", func(t *testing.T) {
		_, err := channelClient.CreateChannel(context.Background(), &chatv1.CreateChannelRequest{
			Name: "Unauthorized Group",
		})
		if err == nil {
			t.Fatal("expected error, got success")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	t.Run("JoinChannel without token fails closed (401 Unauthenticated)", func(t *testing.T) {
		_, err := channelClient.JoinChannel(context.Background(), &chatv1.JoinChannelRequest{
			ChannelId: uuid.New().String(),
		})
		if err == nil {
			t.Fatal("expected error, got success")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	t.Run("UploadPreKeyBundle without token fails closed (401 Unauthenticated)", func(t *testing.T) {
		_, err := keyClient.UploadPreKeyBundle(context.Background(), &chatv1.UploadPreKeyBundleRequest{
			DeviceId: deviceA.String(),
			SignedPreKey: &chatv1.SignedPreKey{
				KeyId:     1,
				PublicKey: []byte("spk-32-bytes-long-key-sample!!!!"),
				Signature: []byte("sig-64-bytes-long-signature-sample-padding-padding-padding-pad!!"),
			},
		})
		if err == nil {
			t.Fatal("expected error, got success")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	t.Run("UploadOneTimeKeys without token fails closed (401 Unauthenticated)", func(t *testing.T) {
		_, err := keyClient.UploadOneTimeKeys(context.Background(), &chatv1.UploadOneTimeKeysRequest{
			DeviceId: deviceA.String(),
			Keys:     []*chatv1.OneTimePreKey{},
		})
		if err == nil {
			t.Fatal("expected error, got success")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	t.Run("GetKeyCount without token fails closed (401 Unauthenticated)", func(t *testing.T) {
		_, err := keyClient.GetKeyCount(context.Background(), &chatv1.GetKeyCountRequest{
			DeviceId: deviceA.String(),
		})
		if err == nil {
			t.Fatal("expected error, got success")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	t.Run("FetchPreKeyBundle without token fails closed (401 Unauthenticated)", func(t *testing.T) {
		_, err := keyClient.FetchPreKeyBundle(context.Background(), &chatv1.FetchPreKeyBundleRequest{
			DeviceId: deviceA.String(),
		})
		if err == nil {
			t.Fatal("expected error, got success")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	// -------------------------------------------------------------------------
	// REGRESSION TEST 2: Device Ownership Binding & Prekey Substitution Prevention
	// -------------------------------------------------------------------------
	t.Run("UploadPreKeyBundle targeting another user's device fails (codes.PermissionDenied)", func(t *testing.T) {
		// User A (Alice) attempts to overwrite Device B (Bob's device) signed pre-key!
		ctx := authCtx(tokenA)
		_, err := keyClient.UploadPreKeyBundle(ctx, &chatv1.UploadPreKeyBundleRequest{
			DeviceId: deviceB.String(), // Attacker targets victim device
			SignedPreKey: &chatv1.SignedPreKey{
				KeyId:     99,
				PublicKey: []byte("attacker-spk-32-bytes-long!!!!!!"),
				Signature: []byte("attacker-sig-64-bytes-long-padding-padding-padding-padding-pad!!"),
			},
		})
		if err == nil {
			t.Fatal("CRITICAL SECURITY FAILURE: Attacker successfully planted pre-key on victim device!")
		}
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("expected codes.PermissionDenied, got %v (%v)", status.Code(err), err)
		}
	})

	t.Run("UploadOneTimeKeys targeting another user's device fails (codes.PermissionDenied)", func(t *testing.T) {
		ctx := authCtx(tokenA)
		_, err := keyClient.UploadOneTimeKeys(ctx, &chatv1.UploadOneTimeKeysRequest{
			DeviceId: deviceB.String(),
			Keys: []*chatv1.OneTimePreKey{
				{KeyId: 1, PublicKey: []byte("attacker-otk-key-32-bytes-long!!")},
			},
		})
		if err == nil {
			t.Fatal("expected PermissionDenied on cross-user OTK upload")
		}
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("expected codes.PermissionDenied, got %v", status.Code(err))
		}
	})

	t.Run("GetKeyCount querying another user's device fails (codes.PermissionDenied)", func(t *testing.T) {
		ctx := authCtx(tokenA)
		_, err := keyClient.GetKeyCount(ctx, &chatv1.GetKeyCountRequest{
			DeviceId: deviceB.String(),
		})
		if err == nil {
			t.Fatal("expected PermissionDenied on cross-user key count query")
		}
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("expected codes.PermissionDenied, got %v", status.Code(err))
		}
	})

	t.Run("UploadPreKeyBundle targeting caller's own device succeeds (codes.OK)", func(t *testing.T) {
		ctx := authCtx(tokenA)
		resp, err := keyClient.UploadPreKeyBundle(ctx, &chatv1.UploadPreKeyBundleRequest{
			DeviceId: deviceA.String(), // Alice uploads to Alice's device
			SignedPreKey: &chatv1.SignedPreKey{
				KeyId:     1,
				PublicKey: []byte("legit-alice-spk-32-bytes-long!"),
				Signature: []byte("legit-alice-sig-64-bytes-long-padding-padding-padding-pad!!!!!"),
			},
		})
		if err != nil {
			t.Fatalf("expected success for owner, got %v", err)
		}
		if resp == nil {
			t.Fatal("expected non-nil response")
		}
	})

	// -------------------------------------------------------------------------
	// REGRESSION TEST 3: Forged x-user-id Header Defeat
	// -------------------------------------------------------------------------
	t.Run("Forged x-user-id header without token is rejected", func(t *testing.T) {
		md := metadata.Pairs("x-user-id", userB.String())
		ctx := metadata.NewOutgoingContext(context.Background(), md)
		_, err := channelClient.CreateChannel(ctx, &chatv1.CreateChannelRequest{
			Name: "Spoofed Header Group",
		})
		if err == nil {
			t.Fatal("expected interceptor to reject unauthenticated request despite forged x-user-id")
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("expected codes.Unauthenticated, got %v", status.Code(err))
		}
	})

	t.Run("Forged x-user-id header with valid token is ignored and caller identity enforced", func(t *testing.T) {
		// Alice supplies valid token, but adds x-user-id: Bob's UUID
		md := metadata.Pairs("authorization", "Bearer "+tokenA, "x-user-id", userB.String())
		ctx := metadata.NewOutgoingContext(context.Background(), md)

		resp, err := channelClient.CreateChannel(ctx, &chatv1.CreateChannelRequest{
			Name: "Group Created By Alice",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp == nil || resp.Channel == nil {
			t.Fatal("expected non-nil channel response")
		}
		// In mockStore, creatorID should match userA (token identity), NOT userB (spoofed header)
		if resp.Channel.CreatorId == userB.String() {
			t.Fatalf("CRITICAL SECURITY HOLE: x-user-id header was used to spoof creator!")
		}
	})

	// -------------------------------------------------------------------------
	// REGRESSION TEST 4: Prekey Bundle Discovery by Authenticated Peers
	// -------------------------------------------------------------------------
	t.Run("Authenticated peer can fetch another user's pre-key bundle", func(t *testing.T) {
		// User B fetches User A's prekey bundle to start an encrypted session
		ctx := authCtx(tokenB)
		resp, err := keyClient.FetchPreKeyBundle(ctx, &chatv1.FetchPreKeyBundleRequest{
			UserId:   userA.String(),
			DeviceId: deviceA.String(),
		})
		if err != nil {
			t.Fatalf("expected authenticated peer to fetch prekey bundle, got %v", err)
		}
		if resp == nil || resp.Bundle == nil {
			t.Fatal("expected non-nil pre-key bundle")
		}
	})
}
