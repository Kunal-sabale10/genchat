package push

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestBuildAPNsPayload(t *testing.T) {
	channelID := "test-channel-123"
	seq := uint64(42)

	data, err := BuildAPNsPayload(channelID, seq)
	if err != nil {
		t.Fatalf("failed to build APNs payload: %v", err)
	}

	var payload APNsSilentPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("failed to unmarshal APNs payload: %v", err)
	}

	if payload.APS.ContentAvailable != 1 {
		t.Fatalf("expected content-available: 1, got %d", payload.APS.ContentAvailable)
	}

	if payload.CID != channelID {
		t.Fatalf("expected CID %s, got %s", channelID, payload.CID)
	}

	if payload.Seq != seq {
		t.Fatalf("expected Seq %d, got %d", seq, payload.Seq)
	}
}

func TestBuildFCMPayload(t *testing.T) {
	token := "sample-fcm-device-token"
	channelID := "test-channel-456"
	seq := uint64(99)

	data, err := BuildFCMPayload(token, channelID, seq)
	if err != nil {
		t.Fatalf("failed to build FCM payload: %v", err)
	}

	var payload FCMSilentPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("failed to unmarshal FCM payload: %v", err)
	}

	if payload.Priority != "high" {
		t.Fatalf("expected priority high, got %s", payload.Priority)
	}

	if payload.Data["channel_id"] != channelID {
		t.Fatalf("expected channel_id %s, got %s", channelID, payload.Data["channel_id"])
	}

	if payload.Data["seq"] != "99" {
		t.Fatalf("expected seq '99', got %s", payload.Data["seq"])
	}
}

func TestProviderRateLimit_Backoff(t *testing.T) {
	d := NewDispatcher(1, 10)
	state := d.GetProviderState(PlatformFCM)

	if state.IsThrottled() {
		t.Fatalf("expected provider not to be throttled initially")
	}

	// Record a rate limit of 100ms
	state.RecordRateLimit(100 * time.Millisecond)
	if !state.IsThrottled() {
		t.Fatalf("expected provider to be throttled after RecordRateLimit")
	}

	// Dispatch should fail closed while throttled
	err := d.dispatch(context.Background(), PushNotification{
		Platform: PlatformFCM,
		DeviceID: "dev1",
	})
	if err != ErrProviderThrottled {
		t.Fatalf("expected ErrProviderThrottled, got %v", err)
	}

	// Wait for rate limit window to elapse
	time.Sleep(120 * time.Millisecond)
	if state.IsThrottled() {
		t.Fatalf("expected provider to no longer be throttled after expiry")
	}
}

func TestProviderCircuitBreaker(t *testing.T) {
	d := NewDispatcher(1, 10)
	state := d.GetProviderState(PlatformAPNs)

	// Simulate 4 failures (threshold is 5)
	for i := 0; i < 4; i++ {
		state.RecordFailure()
	}
	if state.IsThrottled() {
		t.Fatalf("expected circuit breaker not to open before 5 failures")
	}

	// 5th failure trips the circuit
	state.RecordFailure()
	if !state.IsThrottled() {
		t.Fatalf("expected circuit breaker to be open after 5 consecutive failures")
	}

	// Success resets failures and closes circuit
	state.RecordSuccess()
	if state.IsThrottled() {
		t.Fatalf("expected circuit breaker to close after success")
	}
}

