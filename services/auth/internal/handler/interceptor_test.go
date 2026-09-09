package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func makeTestJWT(secret, sub, deviceID string, expiry time.Duration) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"` + sub + `","device_id":"` + deviceID + `","exp":` + string(rune(0)) + `}`))
	// Real payload with unix timestamp
	expUnix := time.Now().Add(expiry).Unix()
	pMap := map[string]any{
		"sub":       sub,
		"device_id": deviceID,
		"exp":       expUnix,
	}
	pBytes, _ := json.Marshal(pMap)
	payload = base64.RawURLEncoding.EncodeToString(pBytes)

	sigBase := header + "." + payload
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(sigBase))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return sigBase + "." + sig
}

func TestUnaryAuthInterceptor_Enforcement(t *testing.T) {
	jwtSecret := "test_super_secret_signing_key_32b_minimum"
	h := &AuthHandler{
		jwtSecret: jwtSecret,
	}
	interceptor := h.UnaryAuthInterceptor()

	aliceID := uuid.New().String()
	aliceDevID := uuid.New().String()
	validToken := makeTestJWT(jwtSecret, aliceID, aliceDevID, 15*time.Minute)
	expiredToken := makeTestJWT(jwtSecret, aliceID, aliceDevID, -1*time.Minute)
	forgedToken := makeTestJWT("wrong-secret-key-attacker", aliceID, aliceDevID, 15*time.Minute)

	mockHandler := func(ctx context.Context, req any) (any, error) {
		uid, err := getUserIDFromCtx(ctx)
		if err != nil {
			return nil, err
		}
		return uid.String(), nil
	}

	t.Run("Protected method with valid Bearer token succeeds", func(t *testing.T) {
		md := metadata.Pairs("authorization", "Bearer "+validToken)
		ctx := metadata.NewIncomingContext(context.Background(), md)
		info := &grpc.UnaryServerInfo{FullMethod: "/chat.v1.ChannelService/CreateChannel"}

		resp, err := interceptor(ctx, nil, info, mockHandler)
		if err != nil {
			t.Fatalf("expected success, got error: %v", err)
		}
		if resp.(string) != aliceID {
			t.Fatalf("expected user_id %s, got %s", aliceID, resp.(string))
		}
	})

	t.Run("Protected method without token fails closed with Unauthenticated", func(t *testing.T) {
		ctx := context.Background()
		info := &grpc.UnaryServerInfo{FullMethod: "/chat.v1.ChannelService/CreateChannel"}

		_, err := interceptor(ctx, nil, info, mockHandler)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		st, ok := status.FromError(err)
		if !ok || st.Code() != codes.Unauthenticated {
			t.Fatalf("expected Unauthenticated, got %v", err)
		}
	})

	t.Run("Protected method with expired token fails closed", func(t *testing.T) {
		md := metadata.Pairs("authorization", "Bearer "+expiredToken)
		ctx := metadata.NewIncomingContext(context.Background(), md)
		info := &grpc.UnaryServerInfo{FullMethod: "/chat.v1.ChannelService/ListChannels"}

		_, err := interceptor(ctx, nil, info, mockHandler)
		if err == nil {
			t.Fatal("expected error for expired token, got nil")
		}
		st, ok := status.FromError(err)
		if !ok || st.Code() != codes.Unauthenticated {
			t.Fatalf("expected Unauthenticated, got %v", err)
		}
	})

	t.Run("Protected method with forged token fails closed", func(t *testing.T) {
		md := metadata.Pairs("authorization", "Bearer "+forgedToken)
		ctx := metadata.NewIncomingContext(context.Background(), md)
		info := &grpc.UnaryServerInfo{FullMethod: "/chat.v1.ChannelService/JoinChannel"}

		_, err := interceptor(ctx, nil, info, mockHandler)
		if err == nil {
			t.Fatal("expected error for forged token, got nil")
		}
		st, ok := status.FromError(err)
		if !ok || st.Code() != codes.Unauthenticated {
			t.Fatalf("expected Unauthenticated, got %v", err)
		}
	})

	t.Run("Identity spoofing with x-user-id metadata is completely defeated", func(t *testing.T) {
		victimID := uuid.New().String()

		// Case A: Attacker supplies x-user-id without any valid token
		mdA := metadata.Pairs("x-user-id", victimID)
		ctxA := metadata.NewIncomingContext(context.Background(), mdA)
		info := &grpc.UnaryServerInfo{FullMethod: "/chat.v1.ChannelService/CreateChannel"}

		_, errA := interceptor(ctxA, nil, info, mockHandler)
		if errA == nil {
			t.Fatal("expected interceptor to reject spoofing request with x-user-id")
		}
		stA, _ := status.FromError(errA)
		if stA.Code() != codes.Unauthenticated {
			t.Fatalf("expected Unauthenticated, got %v", errA)
		}

		// Case B: Attacker supplies valid token for Alice, but attempts to spoof victimID via x-user-id
		mdB := metadata.Pairs("authorization", "Bearer "+validToken, "x-user-id", victimID)
		ctxB := metadata.NewIncomingContext(context.Background(), mdB)

		respB, errB := interceptor(ctxB, nil, info, mockHandler)
		if errB != nil {
			t.Fatalf("interceptor failed on valid token: %v", errB)
		}
		// Must return aliceID from token claims, NOT victimID from x-user-id header
		if respB.(string) != aliceID {
			t.Fatalf("SECURITY VIOLATION: expected authenticated aliceID %s, got spoofed %s", aliceID, respB.(string))
		}
		if respB.(string) == victimID {
			t.Fatalf("CRITICAL SPOOFING VULNERABILITY: x-user-id was accepted over token identity!")
		}
	})

	t.Run("Public registration and login methods pass through unauthenticated", func(t *testing.T) {
		publicMethods := []string{
			"/chat.v1.AuthService/BeginRegistration",
			"/chat.v1.AuthService/FinishRegistration",
			"/chat.v1.AuthService/BeginLogin",
			"/chat.v1.AuthService/FinishLogin",
			"/chat.v1.AuthService/RefreshToken",
			"/chat.v1.AuthService/DevToken",
			"/chat.v1.KeyService/FetchPreKeyBundle",
			"/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
		}

		publicHandler := func(ctx context.Context, req any) (any, error) {
			return "ok", nil
		}

		for _, m := range publicMethods {
			ctx := context.Background()
			info := &grpc.UnaryServerInfo{FullMethod: m}
			resp, err := interceptor(ctx, nil, info, publicHandler)
			if err != nil {
				t.Fatalf("expected public method %s to pass, got error: %v", m, err)
			}
			if resp.(string) != "ok" {
				t.Fatalf("expected 'ok', got %v", resp)
			}
		}
	})

	t.Run("Internal server methods pass through without token", func(t *testing.T) {
		internalMethods := []string{
			"/chat.v1.ChannelService/GetChannelMembers",
			"/chat.v1.PushService/GetPushTokens",
		}
		internalHandler := func(ctx context.Context, req any) (any, error) {
			return "internal_ok", nil
		}
		for _, m := range internalMethods {
			ctx := context.Background()
			info := &grpc.UnaryServerInfo{FullMethod: m}
			resp, err := interceptor(ctx, nil, info, internalHandler)
			if err != nil {
				t.Fatalf("expected internal method %s to pass, got error: %v", m, err)
			}
			if resp.(string) != "internal_ok" {
				t.Fatalf("expected 'internal_ok', got %v", resp)
			}
		}
	})
}
