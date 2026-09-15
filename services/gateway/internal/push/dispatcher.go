package push

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
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
	UserID    string    `json:"user_id,omitempty"`
	Platform  Platform  `json:"platform,omitempty"`
	Token     string    `json:"token,omitempty"`
	Endpoint  string    `json:"endpoint,omitempty"`
	P256dh    []byte    `json:"p256dh,omitempty"`
	Auth      []byte    `json:"auth,omitempty"`
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

// ErrProviderThrottled is returned when an outbound push is skipped due to active provider 429 throttling or an open circuit breaker.
var ErrProviderThrottled = fmt.Errorf("push provider is throttled or circuit breaker open")

// ProviderState tracks rate-limiting and circuit-breaker health for a push provider (APNs, FCM, WebPush).
type ProviderState struct {
	mu                  sync.RWMutex
	ThrottledUntil      time.Time
	ConsecutiveFailures int
	CircuitOpen         bool
	CircuitOpenUntil    time.Time
}

func (p *ProviderState) IsThrottled() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	now := time.Now()
	if now.Before(p.ThrottledUntil) {
		return true
	}
	if p.CircuitOpen && now.Before(p.CircuitOpenUntil) {
		return true
	}
	return false
}

func (p *ProviderState) RecordRateLimit(retryAfter time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if retryAfter <= 0 {
		retryAfter = 5 * time.Second
	}
	p.ThrottledUntil = time.Now().Add(retryAfter)
	slog.Warn("push provider rate limit encountered, backing off", "retry_after", retryAfter)
}

func (p *ProviderState) RecordFailure() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ConsecutiveFailures++
	if p.ConsecutiveFailures >= 5 {
		p.CircuitOpen = true
		p.CircuitOpenUntil = time.Now().Add(30 * time.Second)
		slog.Error("push provider circuit breaker tripped due to consecutive failures", "failures", p.ConsecutiveFailures, "break_duration", 30*time.Second)
	}
}

func (p *ProviderState) RecordSuccess() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ConsecutiveFailures = 0
	p.CircuitOpen = false
}

type Dispatcher struct {
	httpClient      *http.Client
	queue           chan PushNotification
	workers         int
	dispatchedCount atomic.Uint64
	providersMu     sync.RWMutex
	providers       map[Platform]*ProviderState
}

func NewDispatcher(workers int, queueSize int) *Dispatcher {
	return &Dispatcher{
		httpClient: &http.Client{Timeout: 10 * time.Second},
		queue:      make(chan PushNotification, queueSize),
		workers:    workers,
		providers:  make(map[Platform]*ProviderState),
	}
}

func (d *Dispatcher) GetProviderState(platform Platform) *ProviderState {
	d.providersMu.Lock()
	defer d.providersMu.Unlock()
	state, ok := d.providers[platform]
	if !ok {
		state = &ProviderState{}
		d.providers[platform] = state
	}
	return state
}

func (d *Dispatcher) DispatchedTotal() uint64 {
	return d.dispatchedCount.Load()
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
	state := d.GetProviderState(notif.Platform)
	if state.IsThrottled() {
		slog.Warn("push dispatch skipped: provider throttled or circuit open", "platform", notif.Platform, "device_id", notif.DeviceID)
		return ErrProviderThrottled
	}

	d.dispatchedCount.Add(1)

	switch notif.Platform {
	case PlatformAPNs:
		payload, err := BuildAPNsPayload(notif.ChannelID, notif.Sequence)
		if err != nil {
			return err
		}
		slog.Info("dispatched APNs silent push notification",
			"device_id", notif.DeviceID,
			"channel_id", notif.ChannelID,
			"seq", notif.Sequence,
			"payload_size", len(payload),
		)
	case PlatformFCM:
		payload, err := BuildFCMPayload(notif.Token, notif.ChannelID, notif.Sequence)
		if err != nil {
			return err
		}
		slog.Info("dispatched FCM silent push notification",
			"device_id", notif.DeviceID,
			"channel_id", notif.ChannelID,
			"seq", notif.Sequence,
			"payload_size", len(payload),
		)
	case PlatformWebPush:
		slog.Info("dispatched WebPush silent push notification",
			"device_id", notif.DeviceID,
			"endpoint", notif.Endpoint,
			"channel_id", notif.ChannelID,
			"seq", notif.Sequence,
		)
	default:
		slog.Info("dispatched silent push notification",
			"device_id", notif.DeviceID,
			"platform", notif.Platform,
			"channel_id", notif.ChannelID,
			"seq", notif.Sequence,
		)
	}

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
