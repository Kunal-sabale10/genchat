package main

import (
	"encoding/json"
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

	store := storage.NewMinIOStorage(cfg)

	cors := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}
			next(w, r)
		}
	}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	uploadHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			ContentType   string `json:"content_type"`
			ContentLength uint64 `json:"content_length"`
			ByteSize      uint64 `json:"byte_size"`
			Sha256Hash    string `json:"sha256_hash"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}

		contentLength := req.ContentLength
		if contentLength == 0 && req.ByteSize > 0 {
			contentLength = req.ByteSize
		}

		contentType := req.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		res, err := store.GenerateUploadURL(r.Context(), contentType, contentLength, req.Sha256Hash)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Pre-generate download URL so the client has immediate access without a secondary round-trip
		var downloadURL string
		dlRes, dlErr := store.GenerateDownloadURL(r.Context(), res.ObjectKey)
		if dlErr == nil && dlRes != nil {
			downloadURL = dlRes.URL
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"object_key":   res.ObjectKey,
			"blob_id":      res.ObjectKey,
			"upload_url":   res.URL,
			"download_url": downloadURL,
			"expires_at":   res.ExpiresAt,
		})
	})

	http.HandleFunc("/media/upload", uploadHandler)
	http.HandleFunc("/v1/media/upload-url", uploadHandler)

	http.HandleFunc("/media/download", cors(func(w http.ResponseWriter, r *http.Request) {
		objectKey := r.URL.Query().Get("object_key")
		if objectKey == "" {
			objectKey = r.URL.Query().Get("key")
		}
		if objectKey == "" {
			objectKey = r.URL.Query().Get("blob_id")
		}

		if objectKey == "" && r.Method == http.MethodPost {
			var req struct {
				ObjectKey string `json:"object_key"`
				Key       string `json:"key"`
				BlobID    string `json:"blob_id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			if req.ObjectKey != "" {
				objectKey = req.ObjectKey
			} else if req.BlobID != "" {
				objectKey = req.BlobID
			} else {
				objectKey = req.Key
			}
		}

		if objectKey == "" {
			http.Error(w, "missing object_key, key, or blob_id parameter", http.StatusBadRequest)
			return
		}

		res, err := store.GenerateDownloadURL(r.Context(), objectKey)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"object_key":   res.ObjectKey,
			"blob_id":      res.ObjectKey,
			"download_url": res.URL,
			"expires_at":   res.ExpiresAt,
		})
	}))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	slog.Info("mediad listening on HTTP port", "port", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		slog.Error("media server failed", "error", err)
	}
}
