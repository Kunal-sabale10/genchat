package handler

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type clientVisitor struct {
	tokens     float64
	lastRefill time.Time
}

// IPRateLimiter provides thread-safe token-bucket rate limiting per IP address.
type IPRateLimiter struct {
	mu         sync.Mutex
	visitors   map[string]*clientVisitor
	ratePerMin float64
	burst      float64
}

// NewIPRateLimiter creates a new rate limiter with the given requests per minute and burst size.
func NewIPRateLimiter(ratePerMinute, burst int) *IPRateLimiter {
	l := &IPRateLimiter{
		visitors:   make(map[string]*clientVisitor),
		ratePerMin: float64(ratePerMinute),
		burst:      float64(burst),
	}

	// Periodically clean up inactive IPs to prevent memory leaks
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

// Allow reports whether a request from the given IP is permitted under the rate limit.
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

	// Refill tokens based on elapsed seconds
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

// GetClientIP extracts the real client IP address from request headers or remote address.
func GetClientIP(r *http.Request) string {
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
