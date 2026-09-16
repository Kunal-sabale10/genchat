package ws

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"

	"github.com/genchat/services/gateway/internal/loadshed"
	"github.com/genchat/services/gateway/internal/metrics"
	"github.com/genchat/services/gateway/internal/ratelimit"
)

const (
	maxMessageSize  = 64 * 1024 // 64KB
	writeWait       = 10 * time.Second
	pongWait        = 60 * time.Second
	pingPeriod      = 54 * time.Second
	sendChannelSize = 256
)

// MessageHandler processes an incoming packet received from a client connection.
type MessageHandler func(ctx context.Context, conn *Conn, data []byte) error

type HandlerOptions struct {
	MaxConnectionsPerPod int
	MaxDevicesPerUser    int
	PreAuthRatePerMinute int
	PreAuthBurst         int
	Shedder              *loadshed.LoadShedder
}

type Handler struct {
	hub                  *Hub
	messageHandler       MessageHandler
	limiter              *ratelimit.Limiter
	preAuthLimiter       *ratelimit.PreAuthLimiter
	shedder              *loadshed.LoadShedder
	jwtSecret            string
	maxConnectionsPerPod int
	maxDevicesPerUser    int
}

func NewHandler(hub *Hub, msgHandler MessageHandler, limiter *ratelimit.Limiter, jwtSecret string) *Handler {
	return NewHandlerWithOptions(hub, msgHandler, limiter, jwtSecret, HandlerOptions{})
}

func NewHandlerWithOptions(hub *Hub, msgHandler MessageHandler, limiter *ratelimit.Limiter, jwtSecret string, opts HandlerOptions) *Handler {
	maxConns := opts.MaxConnectionsPerPod
	if maxConns <= 0 {
		maxConns = 10000
	}
	maxDevices := opts.MaxDevicesPerUser
	if maxDevices <= 0 {
		maxDevices = 5
	}
	preRate := opts.PreAuthRatePerMinute
	if preRate <= 0 {
		preRate = 60
	}
	preBurst := opts.PreAuthBurst
	if preBurst <= 0 {
		preBurst = 10
	}

	return &Handler{
		hub:                  hub,
		messageHandler:       msgHandler,
		limiter:              limiter,
		preAuthLimiter:       ratelimit.NewPreAuthLimiter(preRate, preBurst),
		shedder:              opts.Shedder,
		jwtSecret:            jwtSecret,
		maxConnectionsPerPod: maxConns,
		maxDevicesPerUser:    maxDevices,
	}
}

func extractClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return ip
	}
	return r.RemoteAddr
}

type jwtClaims struct {
	Sub      string `json:"sub"`
	DeviceID string `json:"device_id"`
	Exp      int64  `json:"exp"`
}

func parseAndValidateJWT(tokenStr, secret string) (*jwtClaims, error) {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid token format: expected 3 parts, got %d", len(parts))
	}

	sigBase := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(sigBase))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
		return nil, fmt.Errorf("signature mismatch")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}

	var claims jwtClaims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, fmt.Errorf("unmarshal claims: %w", err)
	}

	if claims.Exp > 0 && time.Now().Unix() > claims.Exp {
		return nil, fmt.Errorf("token expired")
	}

	return &claims, nil
}

// ServeHTTP upgrades to WebSocket
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 1. Pre-Auth Handshake IP Rate Limiting (Directive 6)
	clientIP := extractClientIP(r)
	if h.preAuthLimiter != nil && !h.preAuthLimiter.Allow(clientIP) {
		metrics.DefaultMetrics.IncPreAuthRateLimitRejections()
		slog.Warn("pre-auth rate limit exceeded on websocket upgrade", "ip", clientIP)
		w.Header().Set("Retry-After", "10")
		http.Error(w, "too many handshake attempts, please slow down", http.StatusTooManyRequests)
		return
	}

	// 2. Global Load-Shedding Circuit Breaker (Directive 5)
	if h.shedder != nil && h.shedder.IsOverloaded() {
		metrics.DefaultMetrics.IncLoadSheddingRejections()
		slog.Warn("load-shedder active: rejecting new connection to protect active sessions")
		w.Header().Set("Retry-After", "60")
		http.Error(w, "server overloaded, shedding new connections", http.StatusServiceUnavailable)
		return
	}

	// 3. Hard Per-Pod Connection Ceiling (Directive 1)
	if h.maxConnectionsPerPod > 0 && h.hub.OnlineCount() >= h.maxConnectionsPerPod {
		metrics.DefaultMetrics.IncConnectionCapacityRejections()
		slog.Warn("pod connection capacity ceiling reached, rejecting connection",
			"online_count", h.hub.OnlineCount(),
			"ceiling", h.maxConnectionsPerPod,
		)
		w.Header().Set("Retry-After", "30")
		http.Error(w, "server connection capacity reached", http.StatusServiceUnavailable)
		return
	}

	// 4. Extract auth token from query param or Authorization header.
	// Cryptographic JWT authentication is strictly enforced. Any unauthenticated
	// spoofing headers (e.g. legacy X-User-ID) are completely ignored. All clients
	// must supply a valid HMAC-SHA256 signed JWT via query param `?token=` or
	// `Authorization: Bearer <token>`. Local dev and tests acquire signed tokens
	// via authd's /dev-token endpoint.
	token := r.URL.Query().Get("token")
	if token == "" {
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
	}

	// 5. Validate JWT — fail closed. A connection with a missing, malformed,
	// expired, or badly-signed token is rejected outright; it is never
	// allowed to fall back to trusting the raw token string as an identity.
	if token == "" {
		http.Error(w, "missing auth token", http.StatusUnauthorized)
		return
	}
	claims, err := parseAndValidateJWT(token, h.jwtSecret)
	if err != nil || claims.Sub == "" {
		slog.Warn("websocket auth rejected", "error", err)
		http.Error(w, "invalid or expired token", http.StatusUnauthorized)
		return
	}
	userID := claims.Sub
	deviceID := claims.DeviceID

	// 6. Per-User Device & Connection Cap (Directive 2)
	// If the same device ID is already connected, cleanly evict the previous stale connection
	// so a reconnecting device supersedes its older socket.
	if deviceID != "" && h.hub.HasDevice(userID, deviceID) {
		slog.Debug("evicting superseded connection for device", "user_id", userID, "device_id", deviceID)
		h.hub.EvictDeviceConnections(userID, deviceID)
	} else if h.maxDevicesPerUser > 0 && h.hub.GetActiveDeviceCount(userID) >= h.maxDevicesPerUser {
		metrics.DefaultMetrics.IncDeviceLimitRejections()
		slog.Warn("user device cap exceeded, rejecting new device connection",
			"user_id", userID,
			"device_id", deviceID,
			"active_devices", h.hub.GetActiveDeviceCount(userID),
			"max", h.maxDevicesPerUser,
		)
		http.Error(w, fmt.Sprintf("device limit exceeded (maximum %d active devices per account)", h.maxDevicesPerUser), http.StatusForbidden)
		return
	}

	// 7. Upgrade connection using nhooyr.io/websocket.
	// InsecureSkipVerify disables the library's Origin check (WebSocket's
	// CSRF protection) and must never be on outside local development —
	// gated on WS_ALLOW_ANY_ORIGIN so it can't ship on accidentally.
	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: os.Getenv("WS_ALLOW_ANY_ORIGIN") == "true",
	})
	if err != nil {
		slog.Error("websocket accept error", "error", err)
		return
	}

	// 8. Create Conn, register with Hub
	conn := &Conn{
		ID:          uuid.New().String(),
		UserID:      userID,
		DeviceID:    deviceID,
		Send:        make(chan []byte, sendChannelSize),
		Hub:         h.hub,
		ConnectedAt: time.Now(),
	}
	h.hub.Register(conn)
	metrics.DefaultMetrics.IncActiveConnections()

	// 9. Start readPump and writePump goroutines
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go h.writePump(ctx, conn, wsConn)
	h.readPump(ctx, conn, wsConn)
}

// readPump reads messages from the WebSocket connection
func (h *Handler) readPump(ctx context.Context, conn *Conn, wsConn *websocket.Conn) {
	defer func() {
		h.hub.Unregister(conn)
		metrics.DefaultMetrics.DecActiveConnections()
		wsConn.Close(websocket.StatusNormalClosure, "read loop exiting")
	}()

	wsConn.SetReadLimit(maxMessageSize)

	for {
		// Read message
		msgType, payload, err := wsConn.Read(ctx)
		if err != nil {
			slog.Error("websocket read error", "error", err)
			break
		}

		if msgType != websocket.MessageBinary && msgType != websocket.MessageText {
			slog.Warn("ignoring unsupported message type")
			continue
		}

		// Check rate limit: apply stricter fresh-connection tier (60/min) for the first 30 seconds (Directive 6)
		isFresh := time.Since(conn.ConnectedAt) < 30*time.Second
		if !h.limiter.AllowTiered(conn.UserID, isFresh) {
			slog.Warn("rate limit exceeded", "user_id", conn.UserID, "is_fresh", isFresh)
			metrics.DefaultMetrics.IncRateLimitDrops()
			errResp, _ := json.Marshal(map[string]string{
				"type":    "error",
				"code":    "RATE_LIMIT_EXCEEDED",
				"message": "rate limit exceeded, please slow down",
			})
			select {
			case conn.Send <- errResp:
			default:
			}
			continue
		}

		// Route via the injected message handler
		if err := h.messageHandler(ctx, conn, payload); err != nil {
			slog.Error("message handler error", "error", err)
		}
	}
}

// writePump writes messages to the WebSocket connection
func (h *Handler) writePump(ctx context.Context, conn *Conn, wsConn *websocket.Conn) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		wsConn.Close(websocket.StatusNormalClosure, "write loop exiting")
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case payload, ok := <-conn.Send:
			if !ok {
				// The hub closed the channel.
				wsConn.Close(websocket.StatusNormalClosure, "channel closed")
				return
			}

			err := wsConn.Write(ctx, websocket.MessageBinary, payload)
			if err != nil {
				slog.Error("websocket write error", "error", err)
				return
			}
		case <-ticker.C:
			// Ping ticker for keepalive
			if err := wsConn.Ping(ctx); err != nil {
				return
			}
		}
	}
}
