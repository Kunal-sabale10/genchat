package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter manages multi-tier WebSocket rate limiters for steady and fresh connections.
type Limiter struct {
	steadyLimiters map[string]*rate.Limiter
	freshLimiters  map[string]*rate.Limiter
	mu             sync.RWMutex

	ratePerMinute      int
	burst              int
	freshRatePerMinute int
	freshBurst         int
}

func NewLimiter(ratePerMinute, burst int) *Limiter {
	return NewTieredLimiter(ratePerMinute, burst, 60, 10)
}

func NewTieredLimiter(ratePerMinute, burst, freshRatePerMinute, freshBurst int) *Limiter {
	if freshRatePerMinute <= 0 {
		freshRatePerMinute = 60
	}
	if freshBurst <= 0 {
		freshBurst = 10
	}
	return &Limiter{
		steadyLimiters:     make(map[string]*rate.Limiter),
		freshLimiters:      make(map[string]*rate.Limiter),
		ratePerMinute:      ratePerMinute,
		burst:              burst,
		freshRatePerMinute: freshRatePerMinute,
		freshBurst:         freshBurst,
	}
}

// Allow checks if a user is within steady-state rate limits.
func (l *Limiter) Allow(userID string) bool {
	return l.GetLimiter(userID).Allow()
}

// AllowTiered checks against the fresh tier (60/min) if isFresh is true,
// or steady-state tier (1200/min) if isFresh is false.
func (l *Limiter) AllowTiered(id string, isFresh bool) bool {
	if isFresh {
		return l.getFreshLimiter(id).Allow()
	}
	return l.GetLimiter(id).Allow()
}

// GetLimiter returns or creates a rate limiter for a steady-state user/connection.
func (l *Limiter) GetLimiter(id string) *rate.Limiter {
	l.mu.RLock()
	limiter, exists := l.steadyLimiters[id]
	l.mu.RUnlock()

	if exists {
		return limiter
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if limiter, exists := l.steadyLimiters[id]; exists {
		return limiter
	}

	limiter = rate.NewLimiter(rate.Every(time.Minute/time.Duration(l.ratePerMinute)), l.burst)
	l.steadyLimiters[id] = limiter
	return limiter
}

func (l *Limiter) getFreshLimiter(id string) *rate.Limiter {
	l.mu.RLock()
	limiter, exists := l.freshLimiters[id]
	l.mu.RUnlock()

	if exists {
		return limiter
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if limiter, exists := l.freshLimiters[id]; exists {
		return limiter
	}

	limiter = rate.NewLimiter(rate.Every(time.Minute/time.Duration(l.freshRatePerMinute)), l.freshBurst)
	l.freshLimiters[id] = limiter
	return limiter
}

// PreAuthLimiter enforces strict rate limiting per remote IP on WebSocket upgrade handshakes
// before any token decoding, preventing handshake storms and unauthenticated connection floods.
type PreAuthLimiter struct {
	ipLimiters    map[string]*rate.Limiter
	mu            sync.RWMutex
	ratePerMinute int
	burst         int
}

func NewPreAuthLimiter(ratePerMinute, burst int) *PreAuthLimiter {
	if ratePerMinute <= 0 {
		ratePerMinute = 60
	}
	if burst <= 0 {
		burst = 10
	}
	return &PreAuthLimiter{
		ipLimiters:    make(map[string]*rate.Limiter),
		ratePerMinute: ratePerMinute,
		burst:         burst,
	}
}

func (p *PreAuthLimiter) Allow(ip string) bool {
	if ip == "" {
		return true
	}
	p.mu.RLock()
	limiter, exists := p.ipLimiters[ip]
	p.mu.RUnlock()

	if exists {
		return limiter.Allow()
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if limiter, exists := p.ipLimiters[ip]; exists {
		return limiter.Allow()
	}

	limiter = rate.NewLimiter(rate.Every(time.Minute/time.Duration(p.ratePerMinute)), p.burst)
	p.ipLimiters[ip] = limiter
	return limiter.Allow()
}
