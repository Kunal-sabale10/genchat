package ratelimit

import (
	"testing"
)

func TestLimiter_SteadyTier(t *testing.T) {
	l := NewLimiter(60, 2)
	if !l.Allow("user1") {
		t.Fatal("expected first request to be allowed")
	}
	if !l.Allow("user1") {
		t.Fatal("expected second request within burst to be allowed")
	}
	if l.Allow("user1") {
		t.Fatal("expected third request exceeding burst to be denied")
	}
}

func TestLimiter_TieredFresh(t *testing.T) {
	// steady 600/min burst 20, fresh 60/min burst 2
	l := NewTieredLimiter(600, 20, 60, 2)

	// Fresh connection should trip on 3rd attempt
	if !l.AllowTiered("conn1", true) {
		t.Fatal("expected first fresh attempt to pass")
	}
	if !l.AllowTiered("conn1", true) {
		t.Fatal("expected second fresh attempt to pass")
	}
	if l.AllowTiered("conn1", true) {
		t.Fatal("expected third fresh attempt to be rate limited")
	}

	// Steady connection for conn2 should allow > 2
	for i := 0; i < 5; i++ {
		if !l.AllowTiered("conn2", false) {
			t.Fatalf("expected steady attempt %d to pass", i)
		}
	}
}

func TestPreAuthLimiter(t *testing.T) {
	p := NewPreAuthLimiter(60, 2)
	ip := "192.168.1.50"

	if !p.Allow(ip) {
		t.Fatal("expected first handshake from IP to pass")
	}
	if !p.Allow(ip) {
		t.Fatal("expected second handshake from IP to pass")
	}
	if p.Allow(ip) {
		t.Fatal("expected third handshake exceeding burst to be blocked")
	}

	// Different IP should not be blocked
	if !p.Allow("10.0.0.1") {
		t.Fatal("expected request from different IP to pass")
	}
}
