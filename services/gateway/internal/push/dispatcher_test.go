package push

import (
	"encoding/json"
	"testing"
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
