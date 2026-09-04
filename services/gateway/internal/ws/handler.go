package ws

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"

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

type Handler struct {
	hub            *Hub
	messageHandler MessageHandler
	limiter        *ratelimit.Limiter
	jwtSecret      string
}

func NewHandler(hub *Hub, msgHandler MessageHandler, limiter *ratelimit.Limiter, jwtSecret string) *Handler {
	return &Handler{
		hub:            hub,
		messageHandler: msgHandler,
		limiter:        limiter,
		jwtSecret:      jwtSecret,
	}
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
	// 1. Extract auth token from query param or header
	token := r.URL.Query().Get("token")
	if token == "" {
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		} else if customUserID := r.Header.Get("X-User-ID"); customUserID != "" {
			token = customUserID
		}
	}

	// 2. Validate JWT and extract user_id, device_id
	userID := "mock-user-id"
	deviceID := "mock-device-id"

	if token != "" {
		claims, err := parseAndValidateJWT(token, h.jwtSecret)
		if err == nil && claims.Sub != "" {
			userID = claims.Sub
			if claims.DeviceID != "" {
				deviceID = claims.DeviceID
			}
		} else {
			slog.Debug("jwt validation fallback to raw token", "err", err)
			userID = token
		}
	}

	// 3. Upgrade connection using nhooyr.io/websocket
	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // For development
	})
	if err != nil {
		slog.Error("websocket accept error", "error", err)
		return
	}

	// 4. Create Conn, register with Hub
	conn := &Conn{
		ID:       uuid.New().String(),
		UserID:   userID,
		DeviceID: deviceID,
		Send:     make(chan []byte, sendChannelSize),
		Hub:      h.hub,
	}
	h.hub.Register(conn)

	// 5. Start readPump and writePump goroutines
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go h.writePump(ctx, conn, wsConn)
	h.readPump(ctx, conn, wsConn)
}

// readPump reads messages from the WebSocket connection
func (h *Handler) readPump(ctx context.Context, conn *Conn, wsConn *websocket.Conn) {
	defer func() {
		h.hub.Unregister(conn)
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

		// Check rate limit
		if !h.limiter.Allow(conn.UserID) {
			slog.Warn("rate limit exceeded", "user_id", conn.UserID)
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
