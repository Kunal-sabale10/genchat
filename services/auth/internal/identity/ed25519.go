package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
)

// GenerateIdentityKeyPair generates a new Ed25519 keypair.
func GenerateIdentityKeyPair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

// Sign signs a message with the private key.
func Sign(privateKey ed25519.PrivateKey, message []byte) []byte {
	return ed25519.Sign(privateKey, message)
}

// Verify verifies a signature against the public key.
func Verify(publicKey ed25519.PublicKey, message, signature []byte) bool {
	return ed25519.Verify(publicKey, message, signature)
}

// ValidatePublicKey validates that a byte slice is a valid Ed25519 public key (32 bytes).
func ValidatePublicKey(key []byte) error {
	if len(key) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid Ed25519 public key length: expected %d, got %d", ed25519.PublicKeySize, len(key))
	}
	return nil
}
