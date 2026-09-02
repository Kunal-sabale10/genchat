package relay

import (
	"context"
	"log/slog"

	"github.com/genchat/services/gateway/internal/ws"
)

// Router handles message routing between connected clients.
type Router struct {
	hub *ws.Hub
}

func NewRouter(hub *ws.Hub) *Router {
	return &Router{
		hub: hub,
	}
}

// RouteMessage routes an incoming message to the appropriate recipient(s).
// In Phase 1, this handles 1:1 messaging.
func (r *Router) RouteMessage(senderUserID string, conversationID string, payload []byte) error {
	// 1. Look up the conversation to find the other participant
	//    (For Phase 1, conversation_id encodes both user IDs or we maintain a map)
	// mock logic to determine recipient:
	recipientUserID := conversationID
	if recipientUserID == senderUserID {
		return nil // don't send to self in this mock
	}

	// 2. Send to recipient via hub.SendToUser()
	r.hub.SendToUser(recipientUserID, payload)

	// 3. If recipient is offline, the message is already persisted in ScyllaDB
	//    and will be delivered on reconnect
	if !r.hub.IsOnline(recipientUserID) {
		slog.Debug("recipient is offline, message will be synced later", "recipient_id", recipientUserID)
	}

	return nil
}

// HandleReceipt processes receipt acknowledgments.
func (r *Router) HandleReceipt(senderUserID string, conversationID string, receiptPayload []byte) error {
	// Similar to RouteMessage, find recipient and forward
	recipientUserID := conversationID
	if recipientUserID != senderUserID {
		r.hub.SendToUser(recipientUserID, receiptPayload)
	}
	return nil
}

// HandleTypingIndicator broadcasts typing status.
func (r *Router) HandleTypingIndicator(senderUserID string, conversationID string, isTyping bool) error {
	recipientUserID := conversationID
	// In real implementation we'd encode this into typing indicator protobuf
	// payload := ...
	// r.hub.SendToUser(recipientUserID, payload)
	slog.Debug("typing indicator", "sender", senderUserID, "recipient", recipientUserID, "is_typing", isTyping)
	return nil
}

// Handle satisfies ws.MessageHandler.
// It extracts routing info from the raw packet and delegates to RouteMessage.
func (r *Router) Handle(ctx context.Context, conn *ws.Conn, data []byte) error {
	// In a full implementation we'd decode the protobuf chat.v1.Packet here
	// to extract the conversation ID and action type.
	// For Phase 1, we use a mock conversation ID.
	mockConversationID := "conv-1"
	return r.RouteMessage(conn.UserID, mockConversationID, data)
}
