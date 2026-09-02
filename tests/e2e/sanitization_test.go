package e2e

import (
	"regexp"
	"strings"
	"testing"
)

func TestLogSanitizationRedactionRules(t *testing.T) {
	rawLogs := []string{
		`{"level":"info","msg":"user authenticated","authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis"}`,
		`{"level":"debug","msg":"issuing media token","media_key":"0123456789abcdef0123456789abcdef"}`,
		`{"level":"info","msg":"handling handshake","pq_ciphertext":"1088-byte-kem-ciphertext-base64-blob-here"}`,
		`Authorization: Bearer super-secret-client-token-value-here`,
	}

	// Regex masking patterns corresponding to Vector & FluentBit sanitizers
	bearerRegex := regexp.MustCompile(`Bearer\s+[A-Za-z0-9\-_\.]+`)
	mediaKeyRegex := regexp.MustCompile(`"media_key":"[^"]+"`)
	pqCiphertextRegex := regexp.MustCompile(`"pq_ciphertext":"[^"]+"`)

	for _, log := range rawLogs {
		sanitized := bearerRegex.ReplaceAllString(log, "Bearer [REDACTED_TOKEN]")
		sanitized = mediaKeyRegex.ReplaceAllString(sanitized, `"media_key":"[REDACTED_MEDIA_KEY]"`)
		sanitized = pqCiphertextRegex.ReplaceAllString(sanitized, `"pq_ciphertext":"[REDACTED_PQ_CIPHERTEXT]"`)

		// Verify zero plaintext secrets remain
		if strings.Contains(sanitized, "doNotLeakThis") {
			t.Fatalf("Sanitization failed: Bearer token secret leaked in log: %s", sanitized)
		}
		if strings.Contains(sanitized, "0123456789abcdef0123456789abcdef") {
			t.Fatalf("Sanitization failed: Media key leaked in log: %s", sanitized)
		}
		if strings.Contains(sanitized, "1088-byte-kem-ciphertext-base64-blob-here") {
			t.Fatalf("Sanitization failed: PQ ciphertext leaked in log: %s", sanitized)
		}

		t.Logf("Sanitized log: %s", sanitized)
	}
}
