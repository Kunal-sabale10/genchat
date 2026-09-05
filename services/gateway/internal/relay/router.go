package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
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

// FetchHistoryFrame is the inbound request to fetch chat history.
type FetchHistoryFrame struct {
	Action         string `json:"action"`
	ChannelID      string `json:"channel_id"`
	Limit          int32  `json:"limit"`
	BeforeServerID string `json:"before_server_id"`
}

// HistoryResponseFrame is sent back with stored messages.
type HistoryResponseFrame struct {
	Type      string              `json:"type"`
	ChannelID string              `json:"channel_id"`
	Messages  []HistoryMessageDTO `json:"messages"`
}

type HistoryMessageDTO struct {
	ServerID      string `json:"server_id"`
	SequenceNum   int64  `json:"sequence_num"`
	SenderID      string `json:"sender_id"`
	ClientMsgID   string `json:"client_msg_id"`
	CiphertextB64 string `json:"ciphertext_base64"`
	CreatedAtUnix int64  `json:"created_at_unix"`
}

// TypingFrame is sent by client when typing state changes.
type TypingFrame struct {
	Action    string `json:"action"`
	ChannelID string `json:"channel_id"`
	IsTyping  bool   `json:"is_typing"`
}

type TypingPushFrame struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	IsTyping  bool   `json:"is_typing"`
}

// ReadReceiptFrame is sent when messages are viewed.
type ReadReceiptFrame struct {
	Action      string `json:"action"`
	ChannelID   string `json:"channel_id"`
	ServerID    string `json:"server_id"`
	SequenceNum int64  `json:"sequence_num"`
}

type ReadReceiptPushFrame struct {
	Type        string `json:"type"`
	ChannelID   string `json:"channel_id"`
	UserID      string `json:"user_id"`
	ServerID    string `json:"server_id"`
	SequenceNum int64  `json:"sequence_num"`
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
	case "fetch_history":
		return r.handleFetchHistory(ctx, conn, data)
	case "typing":
		return r.handleTyping(conn, data)
	case "read_receipt":
		return r.handleReadReceipt(conn, data)
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
	push, _ := json.Marshal(PushFrame{
		Type:          "push",
		ChannelID:     frame.ChannelID,
		SenderID:      conn.UserID,
		CiphertextB64: frame.CiphertextB64,
		MessageType:   frame.MessageType,
		ServerID:      serverID,
		ServerTime:    time.Now().Unix(),
	})

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		// Public channel: broadcast to all connected users except sender
		r.hub.BroadcastAll(conn.UserID, push)
	} else {
		// 1:1 Direct Message: route to recipient
		recipientUserID := frame.ChannelID
		if recipientUserID == conn.UserID {
			// Self-send loopback
			slog.Debug("self-send loopback", "user_id", conn.UserID)
		}
		r.hub.SendToUser(recipientUserID, push)
	}

	slog.Info("message routed",
		"sender", conn.UserID,
		"channel", frame.ChannelID,
		"server_id", serverID,
	)
	return nil
}

func (r *Router) handleFetchHistory(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame FetchHistoryFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse fetch_history frame")
	}
	if frame.ChannelID == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id is required")
	}

	if r.ledger == nil {
		return r.sendError(conn, "PERSISTENCE_UNAVAILABLE", "ledger not configured")
	}

	bucket := time.Now().Format("2006-01")
	msgs, err := r.ledger.FetchMessages(ctx, frame.ChannelID, bucket, frame.Limit, frame.BeforeServerID)
	if err != nil {
		slog.Error("failed to fetch history", "error", err, "channel", frame.ChannelID)
		return r.sendError(conn, "FETCH_FAILED", "could not fetch message history")
	}

	var dtos []HistoryMessageDTO
	for _, m := range msgs {
		dtos = append(dtos, HistoryMessageDTO{
			ServerID:      m.MessageID,
			SequenceNum:   m.SequenceNum,
			SenderID:      m.SenderID,
			ClientMsgID:   m.ClientMsgID,
			CiphertextB64: base64.StdEncoding.EncodeToString(m.EncryptedPayload),
			CreatedAtUnix: m.CreatedAt.Unix(),
		})
	}

	resp, _ := json.Marshal(HistoryResponseFrame{
		Type:      "history",
		ChannelID: frame.ChannelID,
		Messages:  dtos,
	})
	r.hub.SendToUser(conn.UserID, resp)
	return nil
}

func (r *Router) handleTyping(conn *ws.Conn, data []byte) error {
	var frame TypingFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil
	}
	if frame.ChannelID == "" {
		return nil
	}

	push, _ := json.Marshal(TypingPushFrame{
		Type:      "typing",
		ChannelID: frame.ChannelID,
		UserID:    conn.UserID,
		IsTyping:  frame.IsTyping,
	})

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		r.hub.BroadcastAll(conn.UserID, push)
	} else {
		r.hub.SendToUser(frame.ChannelID, push)
	}
	return nil
}

func (r *Router) handleReadReceipt(conn *ws.Conn, data []byte) error {
	var frame ReadReceiptFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil
	}
	if frame.ChannelID == "" || frame.ServerID == "" {
		return nil
	}

	push, _ := json.Marshal(ReadReceiptPushFrame{
		Type:        "read_receipt",
		ChannelID:   frame.ChannelID,
		UserID:      conn.UserID,
		ServerID:    frame.ServerID,
		SequenceNum: frame.SequenceNum,
	})

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		r.hub.BroadcastAll(conn.UserID, push)
	} else {
		r.hub.SendToUser(frame.ChannelID, push)
	}
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
