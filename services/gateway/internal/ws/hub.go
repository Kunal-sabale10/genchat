package ws

import (
	"sync"
)

// Conn represents a connected client
type Conn struct {
	ID       string      // Connection ID (UUID)
	UserID   string
	DeviceID string
	Send     chan []byte // Outbound message channel
	Hub      *Hub
}

// Hub manages all active WebSocket connections
type Hub struct {
	// Map of user_id -> map of conn_id -> *Conn
	connections map[string]map[string]*Conn
	mu          sync.RWMutex

	register   chan *Conn
	unregister chan *Conn
	broadcast  chan *Message
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

func (h *Hub) Run() {
	for {
		select {
		case conn := <-h.register:
			h.mu.Lock()
			if _, ok := h.connections[conn.UserID]; !ok {
				h.connections[conn.UserID] = make(map[string]*Conn)
			}
			h.connections[conn.UserID][conn.ID] = conn
			h.mu.Unlock()

		case conn := <-h.unregister:
			h.mu.Lock()
			if conns, ok := h.connections[conn.UserID]; ok {
				if _, ok := conns[conn.ID]; ok {
					delete(conns, conn.ID)
					close(conn.Send)
					if len(conns) == 0 {
						delete(h.connections, conn.UserID)
					}
				}
			}
			h.mu.Unlock()

		case message := <-h.broadcast:
			h.mu.RLock()
			if conns, ok := h.connections[message.TargetUserID]; ok {
				for _, conn := range conns {
					select {
					case conn.Send <- message.Payload:
					default:
						// If channel is full, we could close connection or drop message
					}
				}
			}
			h.mu.RUnlock()
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
