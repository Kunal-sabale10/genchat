package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Config struct {
	Endpoint        string
	AccessKey       string
	SecretKey       string
	BucketName      string
	UseSSL          bool
	MaxUploadBytes  uint64
	URLValidityMins int
	// Region is the AWS SigV4 region component. MinIO defaults to
	// "us-east-1" regardless of physical location unless configured
	// otherwise — set this to match your MinIO/S3 server's MINIO_REGION.
	Region string
}

type PreSignedURLResult struct {
	ObjectKey string
	URL       string
	ExpiresAt time.Time
}

type MinIOStorage struct {
	cfg Config
}

func NewMinIOStorage(cfg Config) *MinIOStorage {
	if cfg.BucketName == "" {
		cfg.BucketName = "genchat-media"
	}
	if cfg.MaxUploadBytes == 0 {
		cfg.MaxUploadBytes = 100 * 1024 * 1024 // 100 MB default
	}
	if cfg.URLValidityMins == 0 {
		cfg.URLValidityMins = 15 // 15 minutes
	}
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	return &MinIOStorage{cfg: cfg}
}

// GenerateUploadURL creates a pre-signed S3 PUT URL for client-side encrypted blobs
func (s *MinIOStorage) GenerateUploadURL(ctx context.Context, contentType string, contentLength uint64, sha256Hash string) (*PreSignedURLResult, error) {
	if contentLength > s.cfg.MaxUploadBytes {
		return nil, fmt.Errorf("content length %d exceeds maximum upload size %d", contentLength, s.cfg.MaxUploadBytes)
	}

	objectKey := fmt.Sprintf("attachments/%s/%s", time.Now().Format("2006-01-02"), uuid.New().String())
	expiresAt := time.Now().Add(time.Duration(s.cfg.URLValidityMins) * time.Minute)

	// Pre-signed S3 V4 Signature Stub
	signedURL := s.signURL("PUT", objectKey, expiresAt, contentType)

	return &PreSignedURLResult{
		ObjectKey: objectKey,
		URL:       signedURL,
		ExpiresAt: expiresAt,
	}, nil
}

// GenerateDownloadURL creates a pre-signed S3 GET URL for an encrypted blob
func (s *MinIOStorage) GenerateDownloadURL(ctx context.Context, objectKey string) (*PreSignedURLResult, error) {
	if objectKey == "" {
		return nil, fmt.Errorf("object key cannot be empty")
	}

	expiresAt := time.Now().Add(time.Duration(s.cfg.URLValidityMins) * time.Minute)
	signedURL := s.signURL("GET", objectKey, expiresAt, "")

	return &PreSignedURLResult{
		ObjectKey: objectKey,
		URL:       signedURL,
		ExpiresAt: expiresAt,
	}, nil
}

const awsSigV4Service = "s3"

// signURL builds a real AWS Signature Version 4 presigned URL (query-string
// signing, RFC-correct), following the algorithm at
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html.
// A real S3/MinIO server will accept this; the previous implementation
// produced AWS-shaped query params but a custom, non-standard signature
// that any real server would reject.
func (s *MinIOStorage) signURL(method, objectKey string, expiresAt time.Time, contentType string) string {
	scheme := "http"
	if s.cfg.UseSSL {
		scheme = "https"
	}

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, s.cfg.Region, awsSigV4Service)
	expiresSeconds := s.cfg.URLValidityMins * 60

	canonicalURI := "/" + s.cfg.BucketName + "/" + encodePathSegment(objectKey)
	host := s.cfg.Endpoint

	// Query params that participate in the signature. X-Amz-Signature is
	// appended afterward, once, and is never itself part of what's signed.
	query := url.Values{}
	query.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	query.Set("X-Amz-Credential", s.cfg.AccessKey+"/"+credentialScope)
	query.Set("X-Amz-Date", amzDate)
	query.Set("X-Amz-Expires", fmt.Sprintf("%d", expiresSeconds))
	query.Set("X-Amz-SignedHeaders", "host")

	canonicalQueryString := canonicalQuery(query)
	canonicalHeaders := "host:" + host + "\n"
	signedHeaders := "host"

	// Presigned URLs never sign the body — S3 requires this literal value.
	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI,
		canonicalQueryString,
		canonicalHeaders,
		signedHeaders,
		"UNSIGNED-PAYLOAD",
	}, "\n")

	hashedCanonicalRequest := sha256Hex([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hashedCanonicalRequest,
	}, "\n")

	signingKey := deriveSigningKey(s.cfg.SecretKey, dateStamp, s.cfg.Region, awsSigV4Service)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	query.Set("X-Amz-Signature", signature)

	u := url.URL{
		Scheme:   scheme,
		Host:     host,
		Path:     canonicalURI,
		RawQuery: canonicalQuery(query),
	}
	return u.String()
}

// canonicalQuery renders query params sorted by key using strict RFC 3986
// percent-encoding, as SigV4 requires. url.QueryEscape encodes spaces as
// '+' (application/x-www-form-urlencoded), which SigV4 explicitly forbids
// — it requires literal '%20' — so we escape via sigV4Escape instead.
func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, sigV4Escape(k)+"="+sigV4Escape(q.Get(k)))
	}
	return strings.Join(parts, "&")
}

// sigV4Escape percent-encodes a string per RFC 3986 (unreserved characters
// A-Z a-z 0-9 - _ . ~ are left as-is; everything else, including space,
// becomes %XX — never '+').
func sigV4Escape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// encodePathSegment percent-encodes an object key for use in a URI path
// while preserving '/' as a path separator (object keys commonly contain
// slashes, e.g. "attachments/2026-09-05/<uuid>").
func encodePathSegment(objectKey string) string {
	segments := strings.Split(objectKey, "/")
	for i, seg := range segments {
		segments[i] = url.PathEscape(seg)
	}
	return strings.Join(segments, "/")
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func deriveSigningKey(secretKey, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte("aws4_request"))
}
