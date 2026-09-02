package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/genchat/services/media/internal/storage"
)

func main() {
	slog.Info("starting genchat media service (mediad)...")

	minioEndpoint := os.Getenv("MINIO_ENDPOINT")
	if minioEndpoint == "" {
		minioEndpoint = "localhost:9000"
	}

	cfg := storage.Config{
		Endpoint:        minioEndpoint,
		AccessKey:       os.Getenv("MINIO_ROOT_USER"),
		SecretKey:       os.Getenv("MINIO_ROOT_PASSWORD"),
		BucketName:      "genchat-media",
		MaxUploadBytes:  100 * 1024 * 1024, // 100 MB
		URLValidityMins: 15,
	}

	_ = storage.NewMinIOStorage(cfg)

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	slog.Info("mediad listening on HTTP port", "port", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		slog.Error("media server failed", "error", err)
	}
}
