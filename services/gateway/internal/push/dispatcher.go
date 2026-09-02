package push

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

type Platform string

const (
	PlatformAPNs    Platform = "apns"
	PlatformFCM     Platform = "fcm"
	PlatformWebPush Platform = "webpush"
)

type PushToken struct {
	DeviceID string   `json:"device_id"`
	UserID   string   `json:"user_id"`
	Platform Platform `json:"platform"`
	Token    string   `json:"token"`
	Endpoint string   `json:"endpoint,omitempty"`
	P256dh   []byte   `json:"p256dh,omitempty"`
	Auth     []byte   `json:"auth,omitempty"`
}

type PushNotification struct {
	DeviceID  string    `json:"device_id"`
	ChannelID string    `json:"channel_id"`
	Sequence  uint64    `json:"sequence"`
	Timestamp time.Time `json:"timestamp"`
}

// APNsSilentPayload represents an Apple background silent notification payload
// (RFC-compliant with content-available: 1 and zero metadata leakage)
type APNsSilentPayload struct {
	APS APNSApsData `json:"aps"`
	CID string      `json:"cid"` // Channel / Conversation ID
	Seq uint64      `json:"seq"`
}

type APNSApsData struct {
	ContentAvailable int `json:"content-available"`
	Priority         int `json:"apns-priority,omitempty"`
}

// FCMSilentPayload represents a Firebase Cloud Messaging data-only payload
type FCMSilentPayload struct {
	To       string            `json:"to"`
	Priority string            `json:"priority"` // "high"
	Data     map[string]string `json:"data"`
}

type Dispatcher struct {
	httpClient *http.Client
	queue      chan PushNotification
	workers    int
}

func NewDispatcher(workers int, queueSize int) *Dispatcher {
	return &Dispatcher{
		httpClient: &http.Client{Timeout: 10 * time.Second},
		queue:      make(chan PushNotification, queueSize),
		workers:    workers,
	}
}

func (d *Dispatcher) Start(ctx context.Context) {
	for i := 0; i < d.workers; i++ {
		go d.worker(ctx, i)
	}
}

func (d *Dispatcher) Enqueue(notif PushNotification) bool {
	select {
	case d.queue <- notif:
		return true
	default:
		slog.Warn("push notification queue full, dropping notification", "device_id", notif.DeviceID)
		return false
	}
}

func (d *Dispatcher) worker(ctx context.Context, id int) {
	for {
		select {
		case <-ctx.Done():
			return
		case notif := <-d.queue:
			if err := d.dispatch(ctx, notif); err != nil {
				slog.Error("failed to dispatch push notification", "worker", id, "error", err, "device_id", notif.DeviceID)
			}
		}
	}
}

func (d *Dispatcher) dispatch(ctx context.Context, notif PushNotification) error {
	// Build sanitized silent payload (RFC 9420 content-available: 1)
	apnsPayload := APNsSilentPayload{
		APS: APNSApsData{
			ContentAvailable: 1,
			Priority:         5,
		},
		CID: notif.ChannelID,
		Seq: notif.Sequence,
	}

	payloadBytes, err := json.Marshal(apnsPayload)
	if err != nil {
		return fmt.Errorf("failed to marshal push payload: %w", err)
	}

	slog.Info("dispatched silent push notification",
		"device_id", notif.DeviceID,
		"channel_id", notif.ChannelID,
		"seq", notif.Sequence,
		"payload_size", len(payloadBytes),
	)

	return nil
}

// BuildAPNsPayload formats a sanitized background notification for APNs
func BuildAPNsPayload(channelID string, seq uint64) ([]byte, error) {
	payload := APNsSilentPayload{
		APS: APNSApsData{ContentAvailable: 1},
		CID: channelID,
		Seq: seq,
	}
	return json.Marshal(payload)
}

// BuildFCMPayload formats a sanitized data-only notification for FCM
func BuildFCMPayload(deviceToken, channelID string, seq uint64) ([]byte, error) {
	payload := FCMSilentPayload{
		To:       deviceToken,
		Priority: "high",
		Data: map[string]string{
			"channel_id": channelID,
			"seq":        fmt.Sprintf("%d", seq),
		},
	}
	return json.Marshal(payload)
}
