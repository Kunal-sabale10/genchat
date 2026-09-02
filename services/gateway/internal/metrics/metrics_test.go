package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayMetricsPrometheusHandler(t *testing.T) {
	m := &GatewayMetrics{}

	m.IncActiveConnections()
	m.IncActiveConnections()
	m.DecActiveConnections()
	m.IncMessagesReceived()
	m.IncMessagesRouted()
	m.IncRateLimitDrops()
	m.IncDisconnectErrors()

	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()

	handler := m.PrometheusHandler()
	handler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}

	body := w.Body.String()

	if !strings.Contains(body, "websocket_active_connections 1") {
		t.Fatalf("expected active connections 1, got body:\n%s", body)
	}

	if !strings.Contains(body, "websocket_total_connections 2") {
		t.Fatalf("expected total connections 2, got body:\n%s", body)
	}

	if !strings.Contains(body, "gateway_messages_received_total 1") {
		t.Fatalf("expected messages received 1, got body:\n%s", body)
	}

	if !strings.Contains(body, "gateway_rate_limit_drops_total 1") {
		t.Fatalf("expected rate limit drops 1, got body:\n%s", body)
	}
}
