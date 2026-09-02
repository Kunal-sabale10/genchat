package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter manages per-user rate limiters.
type Limiter struct {
	limiters      map[string]*rate.Limiter
	mu            sync.RWMutex
	ratePerMinute int
	burst         int
}

func NewLimiter(ratePerMinute, burst int) *Limiter {
	return &Limiter{
		limiters:      make(map[string]*rate.Limiter),
		ratePerMinute: ratePerMinute,
		burst:         burst,
	}
}

// Allow checks if a user is within rate limits.
func (l *Limiter) Allow(userID string) bool {
	return l.GetLimiter(userID).Allow()
}

// GetLimiter returns or creates a rate limiter for a user.
func (l *Limiter) GetLimiter(userID string) *rate.Limiter {
	l.mu.RLock()
	limiter, exists := l.limiters[userID]
	l.mu.RUnlock()

	if exists {
		return limiter
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	// Double check
	if limiter, exists := l.limiters[userID]; exists {
		return limiter
	}

	limiter = rate.NewLimiter(rate.Every(time.Minute/time.Duration(l.ratePerMinute)), l.burst)
	l.limiters[userID] = limiter
	return limiter
}

// Cleanup removes stale limiters (call periodically).
func (l *Limiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	// Just a simple clear for now, in reality you'd track last access time
	// l.limiters = make(map[string]*rate.Limiter)
}
