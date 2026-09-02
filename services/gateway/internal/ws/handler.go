package ws

import (
	"context"
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
}

func NewHandler(hub *Hub, msgHandler MessageHandler, limiter *ratelimit.Limiter) *Handler {
	return &Handler{
		hub:            hub,
		messageHandler: msgHandler,
		limiter:        limiter,
	}
}

// ServeHTTP upgrades to WebSocket
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 1. Extract auth token from query param or header
	token := r.URL.Query().Get("token")
	if token == "" {
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
	}

	// 2. Validate JWT and extract user_id, device_id
	// FIXME: Replace with real JWT validation
	userID := "mock-user-id"
	if token != "" {
		userID = token // Using token as userID for mockup
	}
	deviceID := "mock-device-id"

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

		if msgType != websocket.MessageBinary {
			slog.Warn("ignoring non-binary message")
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
