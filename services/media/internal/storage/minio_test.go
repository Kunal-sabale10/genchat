package storage

import (
	"context"
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
