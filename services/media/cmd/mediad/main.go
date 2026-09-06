package main

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/genchat/services/media/internal/storage"
)

type clientVisitor struct {
	tokens     float64
	lastRefill time.Time
}

type IPRateLimiter struct {
	mu         sync.Mutex
	visitors   map[string]*clientVisitor
	ratePerMin float64
	burst      float64
}

func NewIPRateLimiter(ratePerMinute, burst int) *IPRateLimiter {
	l := &IPRateLimiter{
		visitors:   make(map[string]*clientVisitor),
		ratePerMin: float64(ratePerMinute),
		burst:      float64(burst),
	}

	go func() {
		for {
			time.Sleep(5 * time.Minute)
			l.mu.Lock()
			now := time.Now()
			for ip, v := range l.visitors {
				if now.Sub(v.lastRefill) > 10*time.Minute {
					delete(l.visitors, ip)
				}
			}
			l.mu.Unlock()
		}
	}()

	return l
}

func (l *IPRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	v, exists := l.visitors[ip]
	if !exists {
		l.visitors[ip] = &clientVisitor{
			tokens:     l.burst - 1,
			lastRefill: now,
		}
		return true
	}

	elapsed := now.Sub(v.lastRefill).Seconds()
	v.lastRefill = now
	tokensToAdd := elapsed * (l.ratePerMin / 60.0)
	v.tokens += tokensToAdd
	if v.tokens > l.burst {
		v.tokens = l.burst
	}

	if v.tokens >= 1.0 {
		v.tokens -= 1.0
		return true
	}

	return false
}

func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 && strings.TrimSpace(parts[0]) != "" {
			return strings.TrimSpace(parts[0])
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func writeErrorJSON(w http.ResponseWriter, r *http.Request, publicMsg string, statusCode int, internalErr error) {
	if internalErr != nil {
		slog.Error(publicMsg, "error", internalErr, "path", r.URL.Path, "remote_addr", r.RemoteAddr)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": publicMsg,
	})
}

func isAllowedOrigin(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	for _, a := range allowed {
		if strings.EqualFold(strings.TrimRight(a, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

func main() {
	slog.Info("starting genchat media service (mediad)...")

	minioEndpoint := os.Getenv("MINIO_ENDPOINT")
	if minioEndpoint == "" {
		minioEndpoint = "localhost:9000"
	}

	allowedOriginsRaw := os.Getenv("ALLOWED_ORIGINS")
	if allowedOriginsRaw == "" {
		allowedOriginsRaw = "http://localhost:3000,http://localhost:5173"
	}
	var allowedOrigins []string
	for _, o := range strings.Split(allowedOriginsRaw, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			allowedOrigins = append(allowedOrigins, trimmed)
		}
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
	rateLimiter := NewIPRateLimiter(60, 20) // 60 req/min, burst 20

	cors := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// Security Headers
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Set("Vary", "Origin")
				if isAllowedOrigin(origin, allowedOrigins) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				} else {
					if r.Method == http.MethodOptions {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					writeErrorJSON(w, r, "forbidden origin", http.StatusForbidden, nil)
					return
				}
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}
			next(w, r)
		}
	}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"healthy"}`))
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"healthy"}`))
	})

	uploadHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}

		if !rateLimiter.Allow(getClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		var req struct {
			ContentType   string `json:"content_type"`
			ContentLength uint64 `json:"content_length"`
			ByteSize      uint64 `json:"byte_size"`
			Sha256Hash    string `json:"sha256_hash"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
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
			writeErrorJSON(w, r, "failed to generate upload authorization", http.StatusBadRequest, err)
			return
		}

		// Pre-generate download URL so client has immediate access without secondary round-trip
		var downloadURL string
		dlRes, dlErr := store.GenerateDownloadURL(r.Context(), res.ObjectKey)
		if dlErr == nil && dlRes != nil {
			downloadURL = dlRes.URL
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
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
		if !rateLimiter.Allow(getClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

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
			writeErrorJSON(w, r, "missing object_key parameter", http.StatusBadRequest, nil)
			return
		}

		res, err := store.GenerateDownloadURL(r.Context(), objectKey)
		if err != nil {
			writeErrorJSON(w, r, "failed to generate download authorization", http.StatusBadRequest, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
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
