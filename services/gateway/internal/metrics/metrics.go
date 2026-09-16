package metrics

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

// GatewayMetrics tracks real-time gateway health, connection, and security metrics
type GatewayMetrics struct {
	ActiveConnections atomic.Int64
	TotalConnections  atomic.Int64
	MessagesReceived  atomic.Int64
	MessagesRouted    atomic.Int64
	RateLimitDrops    atomic.Int64
	DisconnectErrors  atomic.Int64

	// Security Anomaly Counters
	SecurityAnomaliesFallback          atomic.Int64
	SecurityAnomaliesUnauthorizedDelete atomic.Int64
	SecurityAnomaliesUnauthorizedEdit   atomic.Int64
	SecurityAnomaliesUnauthorizedPin    atomic.Int64
	SecurityAnomaliesBlocklistDrop     atomic.Int64
	SecurityAnomaliesRateLimit         atomic.Int64

	// Connection Ceiling & Protection Counters
	ConnectionCapacityRejections atomic.Int64
	DeviceLimitRejections        atomic.Int64
	PreAuthRateLimitRejections   atomic.Int64
	LoadSheddingRejections       atomic.Int64
}

var DefaultMetrics = &GatewayMetrics{}

func (m *GatewayMetrics) IncActiveConnections() {
	m.ActiveConnections.Add(1)
	m.TotalConnections.Add(1)
}

func (m *GatewayMetrics) DecActiveConnections() {
	m.ActiveConnections.Add(-1)
}

func (m *GatewayMetrics) IncMessagesReceived() {
	m.MessagesReceived.Add(1)
}

func (m *GatewayMetrics) IncMessagesRouted() {
	m.MessagesRouted.Add(1)
}

func (m *GatewayMetrics) IncRateLimitDrops() {
	m.RateLimitDrops.Add(1)
}

func (m *GatewayMetrics) IncDisconnectErrors() {
	m.DisconnectErrors.Add(1)
}

// Security Anomaly increments
func (m *GatewayMetrics) IncSecurityAnomalyFallback() {
	m.SecurityAnomaliesFallback.Add(1)
}

func (m *GatewayMetrics) IncSecurityAnomalyUnauthorizedDelete() {
	m.SecurityAnomaliesUnauthorizedDelete.Add(1)
}

func (m *GatewayMetrics) IncSecurityAnomalyUnauthorizedEdit() {
	m.SecurityAnomaliesUnauthorizedEdit.Add(1)
}

func (m *GatewayMetrics) IncSecurityAnomalyUnauthorizedPin() {
	m.SecurityAnomaliesUnauthorizedPin.Add(1)
}

func (m *GatewayMetrics) IncSecurityAnomalyBlocklistDrop() {
	m.SecurityAnomaliesBlocklistDrop.Add(1)
}

func (m *GatewayMetrics) IncSecurityAnomalyRateLimit() {
	m.SecurityAnomaliesRateLimit.Add(1)
}

func (m *GatewayMetrics) IncConnectionCapacityRejections() {
	m.ConnectionCapacityRejections.Add(1)
}

func (m *GatewayMetrics) IncDeviceLimitRejections() {
	m.DeviceLimitRejections.Add(1)
}

func (m *GatewayMetrics) IncPreAuthRateLimitRejections() {
	m.PreAuthRateLimitRejections.Add(1)
}

func (m *GatewayMetrics) IncLoadSheddingRejections() {
	m.LoadSheddingRejections.Add(1)
}

// SecurityAuditEvent represents a structured JSON security audit record
type SecurityAuditEvent struct {
	Tag         string `json:"tag"` // "SECURITY_AUDIT"
	Timestamp   string `json:"timestamp"`
	ActorID     string `json:"actor_id,omitempty"`
	TargetID    string `json:"target_id,omitempty"`
	Action      string `json:"action"`
	Reason      string `json:"reason"`
	AnomalyType string `json:"anomaly_type"`
}

func LogSecurityAudit(actorID, targetID, action, reason, anomalyType string) {
	event := SecurityAuditEvent{
		Tag:         "SECURITY_AUDIT",
		Timestamp:   time.Now().UTC().Format(time.RFC3339Nano),
		ActorID:     actorID,
		TargetID:    targetID,
		Action:      action,
		Reason:      reason,
		AnomalyType: anomalyType,
	}
	bytes, _ := json.Marshal(event)
	slog.Warn(string(bytes))
}

// PrometheusHandler exposes Prometheus-compatible metrics text format
func (m *GatewayMetrics) PrometheusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "# HELP websocket_active_connections Current active WebSocket connections\n")
		fmt.Fprintf(w, "# TYPE websocket_active_connections gauge\n")
		fmt.Fprintf(w, "websocket_active_connections %d\n\n", m.ActiveConnections.Load())

		fmt.Fprintf(w, "# HELP websocket_total_connections Cumulative total WebSocket connections established\n")
		fmt.Fprintf(w, "# TYPE websocket_total_connections counter\n")
		fmt.Fprintf(w, "websocket_total_connections %d\n\n", m.TotalConnections.Load())

		fmt.Fprintf(w, "# HELP gateway_messages_received_total Total incoming WebSocket packets received\n")
		fmt.Fprintf(w, "# TYPE gateway_messages_received_total counter\n")
		fmt.Fprintf(w, "gateway_messages_received_total %d\n\n", m.MessagesReceived.Load())

		fmt.Fprintf(w, "# HELP gateway_messages_routed_total Total messages routed across clients/rooms\n")
		fmt.Fprintf(w, "# TYPE gateway_messages_routed_total counter\n")
		fmt.Fprintf(w, "gateway_messages_routed_total %d\n\n", m.MessagesRouted.Load())

		fmt.Fprintf(w, "# HELP gateway_rate_limit_drops_total Total messages dropped by rate limiter\n")
		fmt.Fprintf(w, "# TYPE gateway_rate_limit_drops_total counter\n")
		fmt.Fprintf(w, "gateway_rate_limit_drops_total %d\n\n", m.RateLimitDrops.Load())

		fmt.Fprintf(w, "# HELP websocket_disconnect_errors_total Total abnormal WebSocket disconnects\n")
		fmt.Fprintf(w, "# TYPE websocket_disconnect_errors_total counter\n")
		fmt.Fprintf(w, "websocket_disconnect_errors_total %d\n\n", m.DisconnectErrors.Load())

		fmt.Fprintf(w, "# HELP security_anomalies_total Total detected security anomalies categorized by type\n")
		fmt.Fprintf(w, "# TYPE security_anomalies_total counter\n")
		fmt.Fprintf(w, "security_anomalies_total{type=\"crypto_fallback\"} %d\n", m.SecurityAnomaliesFallback.Load())
		fmt.Fprintf(w, "security_anomalies_total{type=\"unauthorized_delete\"} %d\n", m.SecurityAnomaliesUnauthorizedDelete.Load())
		fmt.Fprintf(w, "security_anomalies_total{type=\"unauthorized_edit\"} %d\n", m.SecurityAnomaliesUnauthorizedEdit.Load())
		fmt.Fprintf(w, "security_anomalies_total{type=\"unauthorized_pin\"} %d\n", m.SecurityAnomaliesUnauthorizedPin.Load())
		fmt.Fprintf(w, "security_anomalies_total{type=\"blocked_message_drop\"} %d\n", m.SecurityAnomaliesBlocklistDrop.Load())
		fmt.Fprintf(w, "security_anomalies_total{type=\"rate_limit_exceeded\"} %d\n\n", m.SecurityAnomaliesRateLimit.Load())

		fmt.Fprintf(w, "# HELP gateway_connection_capacity_rejections_total Total WebSocket handshakes rejected due to pod connection capacity ceiling\n")
		fmt.Fprintf(w, "# TYPE gateway_connection_capacity_rejections_total counter\n")
		fmt.Fprintf(w, "gateway_connection_capacity_rejections_total %d\n\n", m.ConnectionCapacityRejections.Load())

		fmt.Fprintf(w, "# HELP gateway_device_limit_rejections_total Total WebSocket handshakes rejected due to per-user device limits\n")
		fmt.Fprintf(w, "# TYPE gateway_device_limit_rejections_total counter\n")
		fmt.Fprintf(w, "gateway_device_limit_rejections_total %d\n\n", m.DeviceLimitRejections.Load())

		fmt.Fprintf(w, "# HELP gateway_preauth_rate_limit_rejections_total Total WebSocket upgrade requests blocked by pre-auth IP rate limiter\n")
		fmt.Fprintf(w, "# TYPE gateway_preauth_rate_limit_rejections_total counter\n")
		fmt.Fprintf(w, "gateway_preauth_rate_limit_rejections_total %d\n\n", m.PreAuthRateLimitRejections.Load())

		fmt.Fprintf(w, "# HELP gateway_loadshed_rejections_total Total WebSocket upgrades shed due to system overload\n")
		fmt.Fprintf(w, "# TYPE gateway_loadshed_rejections_total counter\n")
		fmt.Fprintf(w, "gateway_loadshed_rejections_total %d\n", m.LoadSheddingRejections.Load())
	}
}
