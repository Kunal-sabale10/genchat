package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strings"
	"testing"
)

func TestMinIOStorageURLGeneration(t *testing.T) {
	cfg := Config{
		Endpoint:        "localhost:9000",
		AccessKey:       "minioadmin",
		SecretKey:       "minioadmin_secret",
		BucketName:      "genchat-media",
		UseSSL:          false,
		MaxUploadBytes:  10 * 1024 * 1024, // 10 MB
		URLValidityMins: 15,
	}

	store := NewMinIOStorage(cfg)
	ctx := context.Background()

	// 1. Upload URL Generation
	uploadRes, err := store.GenerateUploadURL(ctx, "application/octet-stream", 5*1024*1024, "mock-sha256")
	if err != nil {
		t.Fatalf("failed to generate upload URL: %v", err)
	}

	if !strings.HasPrefix(uploadRes.URL, "http://localhost:9000/genchat-media/attachments/") {
		t.Fatalf("unexpected upload URL format: %s", uploadRes.URL)
	}

	if !strings.Contains(uploadRes.URL, "X-Amz-Signature=") {
		t.Fatalf("upload URL must contain S3 signature query parameter")
	}

	// 2. Upload Exceeding Size Limit
	_, err = store.GenerateUploadURL(ctx, "application/octet-stream", 20*1024*1024, "mock-sha256")
	if err == nil {
		t.Fatalf("expected error when uploading file exceeding MaxUploadBytes")
	}

	// 3. Download URL Generation
	downloadRes, err := store.GenerateDownloadURL(ctx, uploadRes.ObjectKey)
	if err != nil {
		t.Fatalf("failed to generate download URL: %v", err)
	}

	if !strings.HasPrefix(downloadRes.URL, "http://localhost:9000/genchat-media/"+uploadRes.ObjectKey) {
		t.Fatalf("unexpected download URL: %s", downloadRes.URL)
	}
}

// verifySigV4 performs an independent verification of an AWS SigV4 presigned URL
func verifySigV4(rawURL, method, accessKey, secretKey string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	q := u.Query()
	sig := q.Get("X-Amz-Signature")
	if sig == "" {
		return false
	}

	algorithm := q.Get("X-Amz-Algorithm")
	if algorithm != "AWS4-HMAC-SHA256" {
		return false
	}

	credential := q.Get("X-Amz-Credential")
	credParts := strings.Split(credential, "/")
	if len(credParts) != 5 || credParts[0] != accessKey {
		return false
	}
	dateStamp := credParts[1]
	region := credParts[2]
	service := credParts[3]

	amzDate := q.Get("X-Amz-Date")
	if amzDate == "" {
		return false
	}

	// Build canonical query string without X-Amz-Signature
	var keys []string
	for k := range q {
		if k != "X-Amz-Signature" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	var canonicalQueryParts []string
	for _, k := range keys {
		canonicalQueryParts = append(canonicalQueryParts, url.QueryEscape(k)+"="+url.QueryEscape(q.Get(k)))
	}
	canonicalQueryString := strings.Join(canonicalQueryParts, "&")

	canonicalHeaders := "host:" + u.Host + "\n"
	signedHeaders := "host"

	canonicalRequest := strings.Join([]string{
		method,
		u.EscapedPath(),
		canonicalQueryString,
		canonicalHeaders,
		signedHeaders,
		"UNSIGNED-PAYLOAD",
	}, "\n")

	h := sha256.New()
	h.Write([]byte(canonicalRequest))
	hashedReq := hex.EncodeToString(h.Sum(nil))

	credentialScope := strings.Join([]string{dateStamp, region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hashedReq,
	}, "\n")

	hmacSha256 := func(key, data []byte) []byte {
		mac := hmac.New(sha256.New, key)
		mac.Write(data)
		return mac.Sum(nil)
	}

	kDate := hmacSha256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSha256(kDate, []byte(region))
	kService := hmacSha256(kRegion, []byte(service))
	kSigning := hmacSha256(kService, []byte("aws4_request"))

	expectedSig := hex.EncodeToString(hmacSha256(kSigning, []byte(stringToSign)))
	return hmac.Equal([]byte(sig), []byte(expectedSig))
}

func TestSigV4PresignedURLVerificationAndTamperResistance(t *testing.T) {
	cfg := Config{
		Endpoint:        "localhost:9000",
		AccessKey:       "minioadmin",
		SecretKey:       "minioadmin_secret",
		BucketName:      "genchat-media",
		Region:          "us-east-1",
		UseSSL:          false,
		MaxUploadBytes:  10 * 1024 * 1024,
		URLValidityMins: 15,
	}
	store := NewMinIOStorage(cfg)
	ctx := context.Background()

	// 1. Generate legitimate presigned upload URL
	res, err := store.GenerateUploadURL(ctx, "image/png", 1024, "mock-sha")
	if err != nil {
		t.Fatalf("GenerateUploadURL failed: %v", err)
	}

	// 2. Verify legitimate signature passes independent SigV4 validator
	if !verifySigV4(res.URL, "PUT", cfg.AccessKey, cfg.SecretKey) {
		t.Fatalf("Valid presigned PUT URL failed independent SigV4 verification: %s", res.URL)
	}

	// 3. Verify download URL passes validator
	dlRes, err := store.GenerateDownloadURL(ctx, res.ObjectKey)
	if err != nil {
		t.Fatalf("GenerateDownloadURL failed: %v", err)
	}
	if !verifySigV4(dlRes.URL, "GET", cfg.AccessKey, cfg.SecretKey) {
		t.Fatalf("Valid presigned GET URL failed independent SigV4 verification: %s", dlRes.URL)
	}

	// 4. Tamper Test: Modify X-Amz-Expires parameter (privilege escalation)
	u, _ := url.Parse(res.URL)
	q := u.Query()
	q.Set("X-Amz-Expires", "86400") // attempt to extend validity to 24 hours
	u.RawQuery = q.Encode()
	if verifySigV4(u.String(), "PUT", cfg.AccessKey, cfg.SecretKey) {
		t.Fatalf("Tampered X-Amz-Expires MUST be rejected by SigV4 verification!")
	}

	// 5. Tamper Test: Modify target object key (unauthorized access to another user's blob)
	u2, _ := url.Parse(res.URL)
	u2.Path = "/genchat-media/attachments/2026-01-01/another-user-secret-file"
	if verifySigV4(u2.String(), "PUT", cfg.AccessKey, cfg.SecretKey) {
		t.Fatalf("Tampered object key path MUST be rejected by SigV4 verification!")
	}

	// 6. Tamper Test: Corrupt signature hex string
	u3, _ := url.Parse(res.URL)
	q3 := u3.Query()
	origSig := q3.Get("X-Amz-Signature")
	tamperedSig := "f" + origSig[1:]
	if origSig[0] == 'f' {
		tamperedSig = "a" + origSig[1:]
	}
	q3.Set("X-Amz-Signature", tamperedSig)
	u3.RawQuery = q3.Encode()
	if verifySigV4(u3.String(), "PUT", cfg.AccessKey, cfg.SecretKey) {
		t.Fatalf("Corrupted X-Amz-Signature MUST be rejected by SigV4 verification!")
	}

	// 7. Tamper Test: HTTP method mismatch (e.g. GET with a PUT signature)
	if verifySigV4(res.URL, "GET", cfg.AccessKey, cfg.SecretKey) {
		t.Fatalf("Signature for PUT MUST be rejected when executed as GET!")
	}
}
