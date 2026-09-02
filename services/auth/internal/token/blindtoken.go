package token

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"sync"
)

// BlindTokenIssuer handles simplified Privacy Pass-style blind token issuance.
// Phase 1: HMAC-based tokens. Phase 2: full RSA blind signatures (RFC 9474).
type BlindTokenIssuer struct {
	signingKey  []byte
	spentTokens map[[32]byte]bool
	mu          sync.RWMutex
}

// NewBlindTokenIssuer creates a new token issuer with the given signing key.
func NewBlindTokenIssuer(signingKey []byte) *BlindTokenIssuer {
	return &BlindTokenIssuer{
		signingKey:  signingKey,
		spentTokens: make(map[[32]byte]bool),
	}
}

// IssueToken issues a new blind token. Returns token = nonce || HMAC(nonce).
func (i *BlindTokenIssuer) IssueToken() ([]byte, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("failed to generate nonce: %w", err)
	}

	mac := hmac.New(sha256.New, i.signingKey)
	mac.Write(nonce)
	tag := mac.Sum(nil)

	token := make([]byte, 0, 64)
	token = append(token, nonce...)
	token = append(token, tag...)
	return token, nil
}

// RedeemToken verifies a token and marks it as spent.
func (i *BlindTokenIssuer) RedeemToken(token []byte) error {
	if len(token) != 64 {
		return fmt.Errorf("invalid token length: expected 64, got %d", len(token))
	}

	nonce := token[:32]
	givenTag := token[32:]

	// Verify HMAC
	mac := hmac.New(sha256.New, i.signingKey)
	mac.Write(nonce)
	expectedTag := mac.Sum(nil)

	if !hmac.Equal(givenTag, expectedTag) {
		return fmt.Errorf("invalid token: HMAC verification failed")
	}

	// Check if already spent
	tokenHash := sha256.Sum256(token)
	i.mu.Lock()
	defer i.mu.Unlock()

	if i.spentTokens[tokenHash] {
		return fmt.Errorf("token already redeemed")
	}

	i.spentTokens[tokenHash] = true
	return nil
}

// IsSpent checks if a token has been redeemed.
func (i *BlindTokenIssuer) IsSpent(token []byte) bool {
	tokenHash := sha256.Sum256(token)
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.spentTokens[tokenHash]
}
