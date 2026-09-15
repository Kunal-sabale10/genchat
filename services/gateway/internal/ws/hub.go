package ws

import (
	"context"
	"sync"
	"time"
)

// WireFormat indicates whether a client connection uses JSON or binary Protobuf.
type WireFormat int

const (
	FormatJSON WireFormat = iota
	FormatProtobuf
)

// DirectoryRouter defines the interface for cross-instance gateway presence and message routing.
type DirectoryRouter interface {
	RegisterUserGateway(ctx context.Context, userID, instanceID string) error
	DeregisterUserGateway(ctx context.Context, userID, instanceID string) error
	GetUserGateways(ctx context.Context, userID string) ([]string, error)
	PublishToPod(ctx context.Context, targetPodID string, targetUserID string, payload []byte) error
}

// Conn represents a connected client
type Conn struct {
	ID         string      // Connection ID (UUID)
	UserID     string
	DeviceID   string
	Send       chan []byte // Outbound message channel
	Hub        *Hub
	WireFormat WireFormat
}

// Hub manages all active WebSocket connections
type Hub struct {
	// Map of user_id -> map of conn_id -> *Conn
	connections map[string]map[string]*Conn
	mu          sync.RWMutex

	register   chan *Conn
	unregister chan *Conn
	broadcast  chan *Message

	instanceID string
	router     DirectoryRouter
	closing    bool
}

type Message struct {
	TargetUserID string
	Payload      []byte
}

func NewHub() *Hub {
	return &Hub{
		connections: make(map[string]map[string]*Conn),
		register:    make(chan *Conn),
		unregister:  make(chan *Conn),
		broadcast:   make(chan *Message),
	}
}

func NewHubWithRouter(instanceID string, router DirectoryRouter) *Hub {
	h := NewHub()
	h.instanceID = instanceID
	h.router = router
	return h
}

func (h *Hub) SetRouter(instanceID string, router DirectoryRouter) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.instanceID = instanceID
	h.router = router
}

func (h *Hub) Run() {
	for {
		select {
		case conn := <-h.register:
			h.mu.Lock()
			if _, ok := h.connections[conn.UserID]; !ok {
				h.connections[conn.UserID] = make(map[string]*Conn)
			}
			isFirst := len(h.connections[conn.UserID]) == 0
			h.connections[conn.UserID][conn.ID] = conn
			instID := h.instanceID
			r := h.router
			h.mu.Unlock()

			if isFirst && r != nil && instID != "" {
				go func(uid, pod string) {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					_ = r.RegisterUserGateway(ctx, uid, pod)
				}(conn.UserID, instID)
			}

		case conn := <-h.unregister:
			h.mu.Lock()
			isLast := false
			if conns, ok := h.connections[conn.UserID]; ok {
				if _, ok := conns[conn.ID]; ok {
					delete(conns, conn.ID)
					close(conn.Send)
					if len(conns) == 0 {
						delete(h.connections, conn.UserID)
						isLast = true
					}
				}
			}
			instID := h.instanceID
			r := h.router
			h.mu.Unlock()

			if isLast && r != nil && instID != "" {
				go func(uid, pod string) {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					_ = r.DeregisterUserGateway(ctx, uid, pod)
				}(conn.UserID, instID)
			}

		case message := <-h.broadcast:
			h.mu.RLock()
			if conns, ok := h.connections[message.TargetUserID]; ok {
				for _, conn := range conns {
					select {
					case conn.Send <- message.Payload:
					default:
					}
				}
			}
			instID := h.instanceID
			r := h.router
			h.mu.RUnlock()

			// Route to remote gateway pods if user has active sessions elsewhere
			if r != nil && instID != "" {
				go func(uid string, payload []byte, localPod string) {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					pods, err := r.GetUserGateways(ctx, uid)
					if err == nil {
						for _, pod := range pods {
							if pod != localPod {
								_ = r.PublishToPod(ctx, pod, uid, payload)
							}
						}
					}
				}(message.TargetUserID, message.Payload, instID)
			}
		}
	}
}

func (h *Hub) Register(conn *Conn) {
	h.register <- conn
}

func (h *Hub) Unregister(conn *Conn) {
	h.unregister <- conn
}

func (h *Hub) SendToUser(userID string, payload []byte) {
	h.broadcast <- &Message{
		TargetUserID: userID,
		Payload:      payload,
	}
}

func (h *Hub) SendToDevice(userID, deviceID string, payload []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if conns, ok := h.connections[userID]; ok {
		for _, conn := range conns {
			if conn.DeviceID == deviceID {
				select {
				case conn.Send <- payload:
				default:
				}
				break
			}
		}
	}
}

func (h *Hub) BroadcastToUsers(userIDs []string, payload []byte) {
	for _, uid := range userIDs {
		h.SendToUser(uid, payload)
	}
}

// BroadcastAll sends a payload to all connected users, optionally excluding one user (e.g. sender).
func (h *Hub) BroadcastAll(excludeUserID string, payload []byte) {
	h.mu.RLock()
	userIDs := make([]string, 0, len(h.connections))
	for uid := range h.connections {
		if uid != excludeUserID {
			userIDs = append(userIDs, uid)
		}
	}
	h.mu.RUnlock()

	for _, uid := range userIDs {
		h.SendToUser(uid, payload)
	}
}

func (h *Hub) GetActiveDeviceCount(userID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if conns, ok := h.connections[userID]; ok {
		return len(conns)
	}
	return 0
}

func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.connections[userID]
	return ok
}

func (h *Hub) OnlineCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections)
}

// DeliverLocal pushes a payload directly to local connections for a user without remote routing.
// Used when an inbound cross-instance message arrives via Redis subscription for this pod.
func (h *Hub) DeliverLocal(userID string, payload []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if conns, ok := h.connections[userID]; ok {
		for _, conn := range conns {
			select {
			case conn.Send <- payload:
			default:
			}
		}
	}
}

// Drain prepares the hub for pod shutdown:
// 1. Deregisters all local users from the directory router so new messages don't route here.
// 2. Broadcasts a reconnect notification to all active client connections.
// 3. Pauses briefly to let in-flight responses flush before closing.
func (h *Hub) Drain(ctx context.Context, reconnectNotice []byte) {
	h.mu.Lock()
	h.closing = true
	instID := h.instanceID
	r := h.router

	if r != nil && instID != "" {
		for uid := range h.connections {
			_ = r.DeregisterUserGateway(ctx, uid, instID)
		}
	}

	if len(reconnectNotice) > 0 {
		for _, conns := range h.connections {
			for _, conn := range conns {
				select {
				case conn.Send <- reconnectNotice:
				default:
				}
			}
		}
	}
	h.mu.Unlock()

	select {
	case <-ctx.Done():
	case <-time.After(1500 * time.Millisecond):
	}
}

