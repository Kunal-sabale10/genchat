package handler

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// TieredRateLimiter implements multi-dimensional in-memory token bucket rate limiting
// across IP, Device, and User dimensions with specific limits per action.
type TieredRateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*tokenBucket
	cleaning bool
}

type tokenBucket struct {
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

func NewTieredRateLimiter() *TieredRateLimiter {
	l := &TieredRateLimiter{
		buckets: make(map[string]*tokenBucket),
	}

	// Periodic garbage collection of inactive buckets every 10 minutes
	go func() {
		for {
			time.Sleep(10 * time.Minute)
			l.mu.Lock()
			now := time.Now()
			for k, b := range l.buckets {
				if now.Sub(b.lastRefill) > 1*time.Hour {
					delete(l.buckets, k)
				}
			}
			l.mu.Unlock()
		}
	}()

	return l
}

// AllowTiered checks if an action is permitted for the given key and action type.
// If not allowed, returns false and the estimated retry delay in seconds.
func (l *TieredRateLimiter) Allow(action string, key string) (bool, int) {
	var maxTokens float64
	var refillRate float64 // tokens per second

	switch action {
	case "registration":
		// 10 attempts per hour per IP
		maxTokens = 10.0
		refillRate = 10.0 / 3600.0
	case "prekey_upload":
		// 20 prekey uploads per hour per device
		maxTokens = 20.0
		refillRate = 20.0 / 3600.0
	case "channel_create":
		// 30 channel creations per hour per user
		maxTokens = 30.0
		refillRate = 30.0 / 3600.0
	case "device_link":
		// 15 device linking attempts per hour per user
		maxTokens = 15.0
		refillRate = 15.0 / 3600.0
	case "abuse_report":
		// 10 reports per hour per user
		maxTokens = 10.0
		refillRate = 10.0 / 3600.0
	default:
		// Default generic sustained action: 120 per minute
		maxTokens = 120.0
		refillRate = 2.0
	}

	bucketKey := fmt.Sprintf("%s:%s", action, key)

	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	b, exists := l.buckets[bucketKey]
	if !exists {
		l.buckets[bucketKey] = &tokenBucket{
			tokens:     maxTokens - 1.0,
			maxTokens:  maxTokens,
			refillRate: refillRate,
			lastRefill: now,
		}
		return true, 0
	}

	// Refill tokens
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.lastRefill = now
	b.tokens += elapsed * b.refillRate
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}

	if b.tokens >= 1.0 {
		b.tokens -= 1.0
		return true, 0
	}

	// Calculate wait time until 1 token is available
	missing := 1.0 - b.tokens
	retrySec := int(missing / b.refillRate)
	if retrySec < 1 {
		retrySec = 1
	}
	return false, retrySec
}

func (l *TieredRateLimiter) Middleware(action string, keyFunc func(r *http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := keyFunc(r)
		if key == "" {
			key = getClientIP(r)
		}

		allowed, retryAfter := l.Allow(action, key)
		if !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"rate_limit_exceeded","message":"Too many requests for %s. Please try again later.","retry_after":%d}`, action, retryAfter)))
			return
		}
		next(w, r)
	}
}

func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

