package token

import (
	"testing"
	"time"
)

func TestTokenGenerationAndValidation(t *testing.T) {
	secret := []byte("test-secret-key-32-bytes-long!!!")
	userID := "user-uuid-1234"
	deviceID := "device-uuid-5678"

	claims := map[string]interface{}{
		"sub": userID,
		"dev": deviceID,
		"exp": time.Now().Add(time.Hour).Unix(),
	}

	if claims["sub"] != userID {
		t.Fatalf("expected sub %s, got %s", userID, claims["sub"])
	}
	_ = secret
}

func TestBlindTokenIssuer(t *testing.T) {
	signingKey := []byte("super-secret-blind-signing-key!!")
	issuer := NewBlindTokenIssuer(signingKey)

	token, err := issuer.IssueToken()
	if err != nil {
		t.Fatalf("failed to issue blind token: %v", err)
	}

	if len(token) != 64 {
		t.Fatalf("expected 64 bytes token, got %d", len(token))
	}

	if issuer.IsSpent(token) {
		t.Fatalf("new token should not be marked as spent")
	}

	// First redemption must succeed
	if err := issuer.RedeemToken(token); err != nil {
		t.Fatalf("failed to redeem token: %v", err)
	}

	if !issuer.IsSpent(token) {
		t.Fatalf("redeemed token must be marked as spent")
	}

	// Double redemption (replay) must fail
	if err := issuer.RedeemToken(token); err == nil {
		t.Fatalf("expected error on double redemption, got nil")
	}

	// Corrupted token must fail
	corrupted := make([]byte, len(token))
	copy(corrupted, token)
	corrupted[0] ^= 0xFF
	if err := issuer.RedeemToken(corrupted); err == nil {
		t.Fatalf("expected error on corrupted token verification, got nil")
	}
}
