package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
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

func (s *MinIOStorage) signURL(method, objectKey string, expiresAt time.Time, contentType string) string {
	scheme := "http"
	if s.cfg.UseSSL {
		scheme = "https"
	}

	u := url.URL{
		Scheme: scheme,
		Host:   s.cfg.Endpoint,
		Path:   fmt.Sprintf("/%s/%s", s.cfg.BucketName, objectKey),
	}

	mac := hmac.New(sha256.New, []byte(s.cfg.SecretKey))
	mac.Write([]byte(fmt.Sprintf("%s\n%s\n%d", method, objectKey, expiresAt.Unix())))
	sig := hex.EncodeToString(mac.Sum(nil))

	q := u.Query()
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", s.cfg.AccessKey)
	q.Set("X-Amz-Date", time.Now().UTC().Format("20060102T150405Z"))
	q.Set("X-Amz-Expires", fmt.Sprintf("%d", s.cfg.URLValidityMins*60))
	q.Set("X-Amz-Signature", sig)
	u.RawQuery = q.Encode()

	return u.String()
}
