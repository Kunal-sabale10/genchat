package ws

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/genchat/services/gateway/internal/loadshed"
	"github.com/genchat/services/gateway/internal/ratelimit"
)

func dummyMsgHandler(ctx context.Context, conn *Conn, data []byte) error {
	return nil
}

func makeToken(userID, deviceID, secret string) string {
	return generateTestJWT(userID, deviceID, secret, 15*time.Minute)
}

func generateTestJWT(userID, deviceID, secret string, expiry time.Duration) string {
	// Re-use parseAndValidateJWT-compatible generator
	return generateJWTForTest(userID, deviceID, secret, expiry)
}

func generateJWTForTest(userID, deviceID, secret string, expiry time.Duration) string {
	header := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
	claims := makeClaimsJSON(userID, deviceID, time.Now().Add(expiry).Unix())
	payload := base64RawURL(claims)
	sig := hmacSHA256(header+"."+payload, secret)
	return header + "." + payload + "." + sig
}

func makeClaimsJSON(sub, dev string, exp int64) string {
	return `{"sub":"` + sub + `","device_id":"` + dev + `","exp":` + strconv.FormatInt(exp, 10) + `}`
}

func TestHandler_ConnectionCeilingRejection_503(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	secret := "test-secret"
	token := generateJWTForTest("user1", "dev1", secret, time.Hour)

	// Populate hub with 2 connections to reach a ceiling of 2
	conn1 := &Conn{ID: "c1", UserID: "user_a", DeviceID: "d_a", Send: make(chan []byte, 10)}
	conn2 := &Conn{ID: "c2", UserID: "user_b", DeviceID: "d_b", Send: make(chan []byte, 10)}
	hub.Register(conn1)
	hub.Register(conn2)
	time.Sleep(50 * time.Millisecond)

	limiter := ratelimit.NewLimiter(100, 10)
	handler := NewHandlerWithOptions(hub, dummyMsgHandler, limiter, secret, HandlerOptions{
		MaxConnectionsPerPod: 2,
		MaxDevicesPerUser:    5,
	})

	req := httptest.NewRequest("GET", "/ws?token="+token, nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected HTTP 503 for capacity ceiling, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 503 response")
	}
}

func TestHandler_DeviceCapRejection_403(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	secret := "test-secret"

	// Register 2 distinct devices for "user_capped"
	conn1 := &Conn{ID: "c1", UserID: "user_capped", DeviceID: "dev1", Send: make(chan []byte, 10)}
	conn2 := &Conn{ID: "c2", UserID: "user_capped", DeviceID: "dev2", Send: make(chan []byte, 10)}
	hub.Register(conn1)
	hub.Register(conn2)
	time.Sleep(50 * time.Millisecond)

	limiter := ratelimit.NewLimiter(100, 10)
	handler := NewHandlerWithOptions(hub, dummyMsgHandler, limiter, secret, HandlerOptions{
		MaxConnectionsPerPod: 100,
		MaxDevicesPerUser:    2, // ceiling is 2
		DeviceCapPolicy:      "reject_new",
	})

	// Attempting to connect a 3rd distinct device "dev3" should fail with 403
	token := generateJWTForTest("user_capped", "dev3", secret, time.Hour)
	req := httptest.NewRequest("GET", "/ws?token="+token, nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected HTTP 403 for device cap exceeded, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "device limit exceeded") {
		t.Fatalf("expected device limit error message in body, got: %s", w.Body.String())
	}
}

func TestHandler_DeviceCap_EvictOldest(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	secret := "test-secret"

	// Register 2 distinct devices for "user_capped" with conn1 being older
	conn1 := &Conn{
		ID:          "c1",
		UserID:      "user_capped",
		DeviceID:    "dev1",
		Send:        make(chan []byte, 10),
		ConnectedAt: time.Now().Add(-10 * time.Minute),
	}
	conn2 := &Conn{
		ID:          "c2",
		UserID:      "user_capped",
		DeviceID:    "dev2",
		Send:        make(chan []byte, 10),
		ConnectedAt: time.Now().Add(-5 * time.Minute),
	}
	hub.Register(conn1)
	hub.Register(conn2)
	time.Sleep(50 * time.Millisecond)

	limiter := ratelimit.NewLimiter(100, 10)
	handler := NewHandlerWithOptions(hub, dummyMsgHandler, limiter, secret, HandlerOptions{
		MaxConnectionsPerPod: 100,
		MaxDevicesPerUser:    2, // ceiling is 2
		DeviceCapPolicy:      "evict_oldest",
	})

	// Attempting to connect 3rd device "dev3" should trigger evict_oldest
	token := generateJWTForTest("user_capped", "dev3", secret, time.Hour)
	req := httptest.NewRequest("GET", "/ws?token="+token, nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	// Since httptest doesn't support WebSocket upgrade hijacking, ServeHTTP reaches websocket.Accept
	// which won't return 403 Forbidden because the connection was admitted!
	if w.Code == http.StatusForbidden {
		t.Fatalf("expected evict_oldest to admit connection, got 403 Forbidden")
	}

	// Verify dev1 (oldest) received eviction notice
	select {
	case payload := <-conn1.Send:
		var notice map[string]string
		if err := json.Unmarshal(payload, &notice); err != nil {
			t.Fatalf("failed to unmarshal eviction notice: %v", err)
		}
		if notice["type"] != "session_evicted" || notice["reason"] != "device_limit_superseded" {
			t.Fatalf("unexpected eviction notice: %v", notice)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("expected dev1 to receive session_evicted notice")
	}
}

func TestHandler_PreAuthIPLimit_429(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	secret := "test-secret"
	limiter := ratelimit.NewLimiter(100, 10)
	handler := NewHandlerWithOptions(hub, dummyMsgHandler, limiter, secret, HandlerOptions{
		PreAuthRatePerMinute: 60,
		PreAuthBurst:         2, // burst is 2
	})

	// Make 3 requests from same IP
	ip := "203.0.113.19:1234"
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("GET", "/ws", nil)
		req.RemoteAddr = ip
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		// Should fail with 401 missing token, but not 429
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d should not be rate limited", i)
		}
	}

	// 3rd request should hit pre-auth rate limit
	req3 := httptest.NewRequest("GET", "/ws", nil)
	req3.RemoteAddr = ip
	w3 := httptest.NewRecorder()
	handler.ServeHTTP(w3, req3)

	if w3.Code != http.StatusTooManyRequests {
		t.Fatalf("expected HTTP 429 for pre-auth rate limit, got %d", w3.Code)
	}
	if w3.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429 response")
	}
}

func TestHandler_LoadShedding_503(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	secret := "test-secret"
	limiter := ratelimit.NewLimiter(100, 10)

	// Create a shedder configured to trip immediately on >1 goroutine
	shedder := loadshed.New(loadshed.Options{
		MaxGoroutines: 1,
		MaxHeapMB:     8192,
	})

	handler := NewHandlerWithOptions(hub, dummyMsgHandler, limiter, secret, HandlerOptions{
		Shedder: shedder,
	})

	req := httptest.NewRequest("GET", "/ws", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected HTTP 503 for load shedding, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") != "60" {
		t.Fatalf("expected Retry-After: 60, got %s", w.Header().Get("Retry-After"))
	}
}

// Helpers for test JWT creation
func base64RawURL(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func hmacSHA256(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
