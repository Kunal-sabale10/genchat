package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/genchat/services/gateway/internal/ledgerclient"
	"github.com/genchat/services/gateway/internal/ws"
)

// --- Wire frame types ---

// InboundFrame is the JSON envelope sent by the client.
type InboundFrame struct {
	Action        string `json:"action"`
	ChannelID     string `json:"channel_id"`
	ClientMsgID   string `json:"client_msg_id"`
	CiphertextB64 string `json:"ciphertext_base64"`
	MessageType   int    `json:"message_type"`
}

// AckFrame is sent back to the sender upon successful delivery.
type AckFrame struct {
	Type        string `json:"type"`
	ClientMsgID string `json:"client_msg_id"`
	MessageID   string `json:"message_id"`
	SequenceNum int64  `json:"sequence_num"`
}

// PushFrame is sent to the recipient(s).
type PushFrame struct {
	Type          string `json:"type"`
	ChannelID     string `json:"channel_id"`
	SenderID      string `json:"sender_id"`
	CiphertextB64 string `json:"ciphertext_base64"`
	MessageType   int    `json:"message_type"`
	ServerID      string `json:"server_id"`
	ServerTime    int64  `json:"server_time"`
}

// ErrorFrame is sent when a frame cannot be processed.
type ErrorFrame struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Router handles message routing between connected clients.
type Router struct {
	hub    *ws.Hub
	ledger *ledgerclient.Client
}

// NewRouter builds a Router. ledger may be nil (e.g. in unit tests that
// don't need persistence), in which case handleSendMessage falls back to
// in-memory relay only and logs a warning — this should never happen in a
// real deployment, where gatewayd always dials msgledger at startup.
func NewRouter(hub *ws.Hub, ledger *ledgerclient.Client) *Router {
	return &Router{hub: hub, ledger: ledger}
}

// Handle satisfies ws.MessageHandler — entry point for every inbound WebSocket frame.
func (r *Router) Handle(ctx context.Context, conn *ws.Conn, data []byte) error {
	// Parse action from raw JSON
	var base struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(data, &base); err != nil {
		return r.sendError(conn, "INVALID_JSON", "frame is not valid JSON")
	}

	switch base.Action {
	case "send_message":
		return r.handleSendMessage(ctx, conn, data)
	case "ping":
		return r.handlePing(conn)
	default:
		return r.sendError(conn, "UNKNOWN_ACTION", fmt.Sprintf("unknown action: %s", base.Action))
	}
}

func (r *Router) handleSendMessage(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame InboundFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse send_message frame")
	}
	if frame.ChannelID == "" || frame.ClientMsgID == "" || frame.CiphertextB64 == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id, client_msg_id, ciphertext_base64 are required")
	}

	ciphertext, err := base64.StdEncoding.DecodeString(frame.CiphertextB64)
	if err != nil {
		return r.sendError(conn, "INVALID_CIPHERTEXT", "ciphertext_base64 could not be decoded")
	}

	if r.ledger == nil {
		// No ledger connection configured — should never happen outside tests.
		slog.Error("ledger client not configured; message will NOT be durably stored",
			"sender", conn.UserID, "channel", frame.ChannelID)
		return r.sendError(conn, "PERSISTENCE_UNAVAILABLE", "message store is not reachable")
	}

	// Persist synchronously and wait for the durable message_id/sequence_num
	// before acknowledging the sender. If this fails (ledgerd down, Scylla
	// unreachable, etc.) the sender gets an error instead of a false ACK —
	// no message should ever be acknowledged unless it's durably stored.
	stored, err := r.ledger.StoreMessage(ctx, frame.ChannelID, conn.UserID, frame.ClientMsgID, ciphertext, nil, uint32(frame.MessageType))
	if err != nil {
		slog.Error("failed to persist message", "error", err, "sender", conn.UserID, "channel", frame.ChannelID)
		return r.sendError(conn, "PERSISTENCE_FAILED", "message could not be stored")
	}

	serverID := stored.MessageID
	seqNum := stored.SequenceNum
	if stored.Deduplicated {
		// Client retried a client_msg_id we already stored. We don't have
		// the original message_id/seq handy from a dedup response (see
		// grpc_adapter.go); ACK with what we have so the client stops
		// retrying, but this is a known gap — see StoreMessage's TODO.
		slog.Debug("duplicate client_msg_id, not re-storing", "client_msg_id", frame.ClientMsgID)
	}

	// 1. ACK the sender — only sent after successful persistence above.
	ack, _ := json.Marshal(AckFrame{
		Type:        "ack",
		ClientMsgID: frame.ClientMsgID,
		MessageID:   serverID,
		SequenceNum: seqNum,
	})
	r.hub.SendToUser(conn.UserID, ack)

	// 2. Push to channel members
	// Phase 8: 1:1 channels — channel_id IS the recipient user_id
	// Phase 9 will add a channel→members lookup
	recipientUserID := frame.ChannelID
	if recipientUserID == conn.UserID {
		// Self-send (test mode) — still push for loopback verification
		slog.Debug("self-send loopback", "user_id", conn.UserID)
	}

	push, _ := json.Marshal(PushFrame{
		Type:          "push",
		ChannelID:     frame.ChannelID,
		SenderID:      conn.UserID,
		CiphertextB64: frame.CiphertextB64,
		MessageType:   frame.MessageType,
		ServerID:      serverID,
		ServerTime:    time.Now().Unix(),
	})
	r.hub.SendToUser(recipientUserID, push)

	slog.Info("message routed",
		"sender", conn.UserID,
		"channel", frame.ChannelID,
		"server_id", serverID,
	)
	return nil
}

func (r *Router) handlePing(conn *ws.Conn) error {
	pong, _ := json.Marshal(map[string]string{"type": "pong"})
	r.hub.SendToUser(conn.UserID, pong)
	return nil
}

func (r *Router) sendError(conn *ws.Conn, code, msg string) error {
	errFrame, _ := json.Marshal(ErrorFrame{Type: "error", Code: code, Message: msg})
	r.hub.SendToUser(conn.UserID, errFrame)
	return fmt.Errorf("relay error %s: %s", code, msg)
}

// RouteMessage routes an incoming message to the appropriate recipient(s).
// Kept for backward compatibility.
func (r *Router) RouteMessage(senderUserID string, conversationID string, payload []byte) error {
	r.hub.SendToUser(conversationID, payload)
	if !r.hub.IsOnline(conversationID) {
		slog.Debug("recipient is offline, message will be synced later", "recipient_id", conversationID)
	}
	return nil
}

// HandleReceipt processes receipt acknowledgments.
func (r *Router) HandleReceipt(senderUserID string, conversationID string, receiptPayload []byte) error {
	if conversationID != senderUserID {
		r.hub.SendToUser(conversationID, receiptPayload)
	}
	return nil
}
