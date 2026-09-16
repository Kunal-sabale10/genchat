package loadshed

import (
	"log/slog"
	"runtime"
	"sync"
	"time"
)

// Options configure the load shedding thresholds.
type Options struct {
	MaxGoroutines int   // Maximum active goroutines before shedding new connections
	MaxHeapMB     int64 // Maximum allocated heap in megabytes before shedding
}

// DefaultOptions returns conservative production thresholds.
func DefaultOptions() Options {
	return Options{
		MaxGoroutines: 25000,
		MaxHeapMB:     1024, // 1GB
	}
}

// LoadShedder evaluates system resource pressure to protect active connections
// and shed non-critical operations before the gateway becomes unresponsive.
type LoadShedder struct {
	opts       Options
	mu         sync.RWMutex
	overloaded bool
	lastCheck  time.Time
}

// New creates a new LoadShedder with the given options.
func New(opts Options) *LoadShedder {
	if opts.MaxGoroutines <= 0 {
		opts.MaxGoroutines = 25000
	}
	if opts.MaxHeapMB <= 0 {
		opts.MaxHeapMB = 1024
	}
	return &LoadShedder{
		opts: opts,
	}
}

// IsOverloaded returns true if current system metrics exceed safe thresholds.
// New connection handshakes should immediately be rejected with HTTP 503 when true.
func (s *LoadShedder) IsOverloaded() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Rate-limit runtime sampling to once every 250ms to minimize stop-the-world overhead
	now := time.Now()
	if now.Sub(s.lastCheck) < 250*time.Millisecond {
		return s.overloaded
	}
	s.lastCheck = now

	goroutines := runtime.NumGoroutine()
	if goroutines >= s.opts.MaxGoroutines {
		if !s.overloaded {
			slog.Warn("load-shedder tripped: goroutines exceeded threshold",
				"goroutines", goroutines,
				"max", s.opts.MaxGoroutines,
			)
		}
		s.overloaded = true
		return true
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	heapMB := int64(m.Alloc / (1024 * 1024))
	if heapMB >= s.opts.MaxHeapMB {
		if !s.overloaded {
			slog.Warn("load-shedder tripped: heap memory exceeded threshold",
				"heap_mb", heapMB,
				"max_mb", s.opts.MaxHeapMB,
			)
		}
		s.overloaded = true
		return true
	}

	if s.overloaded {
		slog.Info("load-shedder recovered: resources within safe operating bounds",
			"goroutines", goroutines,
			"heap_mb", heapMB,
		)
	}
	s.overloaded = false
	return false
}

// ShouldShedNonCritical returns true if system is under elevated pressure
// and should defer non-essential background tasks (e.g. AI summaries, typing storms).
// Trips at 80% of the hard overload ceiling.
func (s *LoadShedder) ShouldShedNonCritical() bool {
	if s.IsOverloaded() {
		return true
	}

	goroutines := runtime.NumGoroutine()
	if goroutines >= (s.opts.MaxGoroutines * 8 / 10) {
		return true
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	heapMB := int64(m.Alloc / (1024 * 1024))
	if heapMB >= (s.opts.MaxHeapMB * 8 / 10) {
		return true
	}

	return false
}
