package metrics

import (
	"fmt"
	"net/http"
	"sync/atomic"
)

// GatewayMetrics tracks real-time gateway health and connection metrics
type GatewayMetrics struct {
	ActiveConnections atomic.Int64
	TotalConnections  atomic.Int64
	MessagesReceived  atomic.Int64
	MessagesRouted    atomic.Int64
	RateLimitDrops    atomic.Int64
	DisconnectErrors  atomic.Int64
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
		fmt.Fprintf(w, "websocket_disconnect_errors_total %d\n", m.DisconnectErrors.Load())
	}
}
