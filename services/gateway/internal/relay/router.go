package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/gateway/internal/ledgerclient"
	"github.com/genchat/services/gateway/internal/push"
	"github.com/genchat/services/gateway/internal/ws"
)

// --- Wire frame types ---

// InboundFrame is the JSON envelope sent by the client.
type InboundFrame struct {
	Action           string `json:"action"`
	ChannelID        string `json:"channel_id"`
	ClientMsgID      string `json:"client_msg_id"`
	CiphertextB64    string `json:"ciphertext_base64"`
	MessageType      int    `json:"message_type"`
	EphemeralTTLSec  int64  `json:"ephemeral_ttl_sec,omitempty"`
	ReplyToMessageID string `json:"reply_to_message_id,omitempty"`
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
	Type             string `json:"type"`
	ChannelID        string `json:"channel_id"`
	SenderID         string `json:"sender_id"`
	CiphertextB64    string `json:"ciphertext_base64"`
	MessageType      int    `json:"message_type"`
	ServerID         string `json:"server_id"`
	ServerTime       int64  `json:"server_time"`
	EphemeralTTLSec  int64  `json:"ephemeral_ttl_sec,omitempty"`
	ReplyToMessageID string `json:"reply_to_message_id,omitempty"`
}

// ReactionInboundFrame is sent by a client to add or remove an emoji reaction.
type ReactionInboundFrame struct {
	Action      string `json:"action"`                  // "reaction"
	ChannelID   string `json:"channel_id"`              // channel ID or recipient user ID
	TargetID    string `json:"target_id"`               // target message_id / client_msg_id
	TargetMsgID string `json:"target_msg_id,omitempty"` // alias for target_id
	Emoji       string `json:"emoji"`                   // emoji string, e.g. "👍", "❤️", "🔥"
	Op          string `json:"op"`                      // "add" | "remove"
}

// ReactionPushFrame is relayed to conversation participants.
type ReactionPushFrame struct {
	Type        string `json:"type"`          // "reaction"
	ChannelID   string `json:"channel_id"`
	TargetID    string `json:"target_id"`
	TargetMsgID string `json:"target_msg_id"` // alias for backward/flexible compatibility
	SenderID    string `json:"sender_id"`
	Emoji       string `json:"emoji"`
	Op          string `json:"op"`
	ServerTime  int64  `json:"server_time"`
}

// DeleteMessageInboundFrame is sent by a client to delete or revoke a message.
type DeleteMessageInboundFrame struct {
	Action      string `json:"action"`                  // "delete_message"
	ChannelID   string `json:"channel_id"`              // channel ID or recipient user ID
	MessageID   string `json:"message_id"`              // target message ID
	ClientMsgID string `json:"client_msg_id,omitempty"` // alias for target message ID
	DeleteScope string `json:"delete_scope"`            // "everyone" | "me"
}

// DeleteMessagePushFrame is relayed to conversation participants when a message is revoked.
type DeleteMessagePushFrame struct {
	Type        string `json:"type"`         // "message_deleted"
	ChannelID   string `json:"channel_id"`
	MessageID   string `json:"message_id"`
	SenderID    string `json:"sender_id"`
	DeleteScope string `json:"delete_scope"` // "everyone"
	ServerTime  int64  `json:"server_time"`
}

// AckDeleteFrame is sent back to the requester confirming deletion.
type AckDeleteFrame struct {
	Type        string `json:"type"`         // "ack_delete"
	MessageID   string `json:"message_id"`
	ChannelID   string `json:"channel_id"`
	DeleteScope string `json:"delete_scope"`
}

// EditMessageInboundFrame is sent by a client to edit a previously sent message.
type EditMessageInboundFrame struct {
	Action        string `json:"action"`                  // "edit_message"
	ChannelID     string `json:"channel_id"`              // channel ID or recipient user ID
	MessageID     string `json:"message_id"`              // target message ID
	ClientMsgID   string `json:"client_msg_id,omitempty"` // alias for target message ID
	CiphertextB64 string `json:"ciphertext_base64"`      // updated encrypted ciphertext
}

// EditMessagePushFrame is relayed to conversation participants when a message is edited.
type EditMessagePushFrame struct {
	Type          string `json:"type"`              // "message_edited"
	ChannelID     string `json:"channel_id"`
	MessageID     string `json:"message_id"`
	SenderID      string `json:"sender_id"`
	CiphertextB64 string `json:"ciphertext_base64"`
	ServerTime    int64  `json:"server_time"`
}

// AckEditFrame is sent back to the requester confirming edit relay.
type AckEditFrame struct {
	Type       string `json:"type"`       // "ack_edit"
	MessageID  string `json:"message_id"`
	ChannelID  string `json:"channel_id"`
	ServerTime int64  `json:"server_time"`
}

// PinMessageInboundFrame is sent by a client to pin or unpin a message.
type PinMessageInboundFrame struct {
	Action      string `json:"action"`                  // "pin_message"
	ChannelID   string `json:"channel_id"`              // channel ID or recipient user ID
	MessageID   string `json:"message_id"`              // target message ID
	ClientMsgID string `json:"client_msg_id,omitempty"` // alias for target message ID
	Op          string `json:"op,omitempty"`            // "pin" or "unpin" (defaults to "pin")
}

// PinMessagePushFrame is relayed to conversation participants when a message is pinned/unpinned.
type PinMessagePushFrame struct {
	Type       string `json:"type"`       // "message_pinned"
	ChannelID  string `json:"channel_id"`
	MessageID  string `json:"message_id"`
	SenderID   string `json:"sender_id"`
	Op         string `json:"op"`         // "pin" or "unpin"
	ServerTime int64  `json:"server_time"`
}

// AckPinFrame is sent back to the requester confirming pin relay.
type AckPinFrame struct {
	Type       string `json:"type"`       // "ack_pin"
	MessageID  string `json:"message_id"`
	ChannelID  string `json:"channel_id"`
	Op         string `json:"op"`
	ServerTime int64  `json:"server_time"`
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
	ServerID        string `json:"server_id"`
	SequenceNum     int64  `json:"sequence_num"`
	SenderID        string `json:"sender_id"`
	ClientMsgID     string `json:"client_msg_id"`
	CiphertextB64   string `json:"ciphertext_base64"`
	CreatedAtUnix   int64  `json:"created_at_unix"`
	EphemeralTTLSec int64  `json:"ephemeral_ttl_sec,omitempty"`
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

// CallSignalInboundFrame is sent by a client to initiate, negotiate, or end a WebRTC call.
type CallSignalInboundFrame struct {
	Action       string          `json:"action"` // "call_signal"
	SignalType   string          `json:"signal_type"` // "offer", "answer", "ice_candidate", "hangup", "reject", "group_join", "group_leave", "group_ping"
	CallID       string          `json:"call_id"`
	ChannelID    string          `json:"channel_id,omitempty"`
	TargetUserID string          `json:"target_user_id,omitempty"`
	CallType     string          `json:"call_type,omitempty"` // "audio" | "video"
	SDP          string          `json:"sdp,omitempty"`
	Candidate    json.RawMessage `json:"candidate,omitempty"`
}

// CallSignalPushFrame is relayed to the target peer or group members.
type CallSignalPushFrame struct {
	Type         string          `json:"type"` // "call_signal"
	SignalType   string          `json:"signal_type"`
	CallID       string          `json:"call_id"`
	ChannelID    string          `json:"channel_id,omitempty"`
	SenderID     string          `json:"sender_id"`
	TargetUserID string          `json:"target_user_id,omitempty"`
	CallType     string          `json:"call_type,omitempty"`
	SDP          string          `json:"sdp,omitempty"`
	Candidate    json.RawMessage `json:"candidate,omitempty"`
	ServerTime   int64           `json:"server_time,omitempty"`
}

// GroupCommitFrame is sent by a client when an MLS epoch advances (member added/removed/rekeyed).
type GroupCommitFrame struct {
	Action     string `json:"action"` // "group_commit"
	ChannelID  string `json:"channel_id"`
	Epoch      uint64 `json:"epoch"`
	CommitData string `json:"commit_data"` // base64 or JSON string
}

// GroupCommitPushFrame is broadcast to all channel members so their local MLS trees advance.
type GroupCommitPushFrame struct {
	Type       string `json:"type"` // "group_commit"
	ChannelID  string `json:"channel_id"`
	SenderID   string `json:"sender_id"`
	Epoch      uint64 `json:"epoch"`
	CommitData string `json:"commit_data"`
	ServerTime int64  `json:"server_time"`
}

// EphemeralSettingFrame is sent when a participant changes the disappearing message TTL.
type EphemeralSettingFrame struct {
	Action          string `json:"action"` // "ephemeral_setting"
	ChannelID       string `json:"channel_id"`
	EphemeralTTLSec int64  `json:"ephemeral_ttl_sec"`
}

// EphemeralSettingPushFrame is broadcast to conversation participants.
type EphemeralSettingPushFrame struct {
	Type            string `json:"type"` // "ephemeral_setting"
	ChannelID       string `json:"channel_id"`
	EphemeralTTLSec int64  `json:"ephemeral_ttl_sec"`
	UpdatedBy       string `json:"updated_by"`
	UpdatedAt       int64  `json:"updated_at"`
}

// Router handles message routing between connected clients.
type Router struct {
	hub           *ws.Hub
	ledger        *ledgerclient.Client
	pushClient    chatv1.PushServiceClient
	channelClient chatv1.ChannelServiceClient
	dispatcher    *push.Dispatcher
}

// NewRouter builds a Router. ledger, pushClient, channelClient, or dispatcher may be nil in tests.
func NewRouter(hub *ws.Hub, ledger *ledgerclient.Client, pushClient chatv1.PushServiceClient, channelClient chatv1.ChannelServiceClient, dispatcher *push.Dispatcher) *Router {
	return &Router{
		hub:           hub,
		ledger:        ledger,
		pushClient:    pushClient,
		channelClient: channelClient,
		dispatcher:    dispatcher,
	}
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
	case "reaction":
		return r.handleReaction(ctx, conn, data)
	case "delete_message":
		return r.handleDeleteMessage(ctx, conn, data)
	case "edit_message":
		return r.handleEditMessage(ctx, conn, data)
	case "pin_message":
		return r.handlePinMessage(ctx, conn, data)
	case "group_commit", "mls_commit":
		return r.handleGroupCommit(ctx, conn, data)
	case "fetch_history":
		return r.handleFetchHistory(ctx, conn, data)
	case "typing":
		return r.handleTyping(conn, data)
	case "read_receipt", "ack_receipt":
		return r.handleReadReceipt(ctx, conn, data)
	case "call_signal":
		return r.handleCallSignal(ctx, conn, data)
	case "ephemeral_setting":
		return r.handleEphemeralSetting(ctx, conn, data)
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
	conversationID := getConversationID(conn.UserID, frame.ChannelID)
	stored, err := r.ledger.StoreMessage(ctx, conversationID, conn.UserID, frame.ClientMsgID, ciphertext, nil, uint32(frame.MessageType), frame.EphemeralTTLSec)
	if err != nil {
		slog.Error("failed to persist message", "error", err, "sender", conn.UserID, "channel", frame.ChannelID)
		return r.sendError(conn, "PERSISTENCE_FAILED", "message could not be stored")
	}

	serverID := stored.MessageID
	seqNum := stored.SequenceNum

	// 1. ACK the sender — only sent after durable persistence above.
	// On retried client_msg_id, this returns the original durable serverID and seqNum.
	ack, _ := json.Marshal(AckFrame{
		Type:        "ack",
		ClientMsgID: frame.ClientMsgID,
		MessageID:   serverID,
		SequenceNum: seqNum,
	})
	r.hub.SendToUser(conn.UserID, ack)

	if stored.Deduplicated {
		slog.Debug("duplicate client_msg_id retried; ACKed with original metadata, skipping duplicate push",
			"client_msg_id", frame.ClientMsgID, "server_id", serverID, "seq", seqNum)
		return nil
	}

	// 2. Push to channel members
	push, _ := json.Marshal(PushFrame{
		Type:             "push",
		ChannelID:        frame.ChannelID,
		SenderID:         conn.UserID,
		CiphertextB64:    frame.CiphertextB64,
		MessageType:      frame.MessageType,
		ServerID:         serverID,
		ServerTime:       time.Now().Unix(),
		EphemeralTTLSec:  frame.EphemeralTTLSec,
		ReplyToMessageID: frame.ReplyToMessageID,
	})

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string

		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil && len(resp.GetMembers()) > 0 {
				isMember := false
				for _, m := range resp.GetMembers() {
					if m.GetUserId() == conn.UserID {
						isMember = true
					}
					memberIDs = append(memberIDs, m.GetUserId())
				}
				if !isMember {
					return r.sendError(conn, "FORBIDDEN", "user is not a member of this channel")
				}
			} else {
				slog.Debug("channel member lookup skipped or failed; using broadcast", "channel", frame.ChannelID, "error", err)
			}
		}

		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				if uid == conn.UserID {
					continue
				}
				if r.hub.IsOnline(uid) {
					r.hub.SendToUser(uid, push)
				} else if r.dispatcher != nil {
					go r.notifyOfflineRecipient(uid, frame.ChannelID, uint64(seqNum))
				}
			}
		} else if frame.ChannelID == "chan_public" {
			// Broadcast fallback exclusively for the designated public channel
			r.hub.BroadcastAll(conn.UserID, push)
		} else {
			slog.Warn("cannot route channel message: no members resolved", "channel", frame.ChannelID)
			return r.sendError(conn, "CHANNEL_NOT_FOUND", "channel members could not be resolved")
		}
	} else {
		// 1:1 Direct Message: route to recipient
		recipientUserID := frame.ChannelID
		if recipientUserID == conn.UserID {
			// Self-send loopback
			slog.Debug("self-send loopback", "user_id", conn.UserID)
		}
		r.hub.SendToUser(recipientUserID, push)

		// If recipient is offline, dispatch silent background push notification
		if !r.hub.IsOnline(recipientUserID) && r.dispatcher != nil {
			go r.notifyOfflineRecipient(recipientUserID, frame.ChannelID, uint64(seqNum))
		}
	}

	slog.Info("message routed",
		"sender", conn.UserID,
		"channel", frame.ChannelID,
		"server_id", serverID,
	)
	return nil
}

func (r *Router) handleGroupCommit(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame GroupCommitFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse group_commit frame")
	}
	if frame.ChannelID == "" || frame.CommitData == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id and commit_data are required")
	}

	cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")

	// Decode commit data
	commitBytes, err := base64.StdEncoding.DecodeString(frame.CommitData)
	if err != nil || len(commitBytes) == 0 {
		commitBytes = []byte(frame.CommitData)
	}

	var memberIDs []string
	if r.channelClient != nil {
		resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
			ChannelId: cleanID,
		})
		if err == nil && len(resp.GetMembers()) > 0 {
			isMember := false
			for _, m := range resp.GetMembers() {
				if m.GetUserId() == conn.UserID {
					isMember = true
				}
				memberIDs = append(memberIDs, m.GetUserId())
			}
			if !isMember && cleanID != "public" {
				return r.sendError(conn, "FORBIDDEN", "user is not a member of this channel")
			}
		}
	}

	// Persist commit in auth/channel service if client configured
	if r.channelClient != nil {
		_, err := r.channelClient.CommitEpoch(ctx, &chatv1.CommitEpochRequest{
			ChannelId:  cleanID,
			Epoch:      frame.Epoch,
			CommitData: commitBytes,
		})
		if err != nil {
			slog.Warn("channelClient.CommitEpoch failed", "error", err, "channel", cleanID)
		}
	}

	// Fan out group commit push to all channel members
	pushPayload, _ := json.Marshal(GroupCommitPushFrame{
		Type:       "group_commit",
		ChannelID:  frame.ChannelID,
		SenderID:   conn.UserID,
		Epoch:      frame.Epoch,
		CommitData: frame.CommitData,
		ServerTime: time.Now().Unix(),
	})

	if len(memberIDs) > 0 {
		for _, uid := range memberIDs {
			if uid == conn.UserID {
				continue
			}
			if r.hub.IsOnline(uid) {
				r.hub.SendToUser(uid, pushPayload)
			}
		}
	} else if frame.ChannelID == "chan_public" {
		r.hub.BroadcastAll(conn.UserID, pushPayload)
	} else {
		slog.Warn("cannot route group commit: no members resolved", "channel", frame.ChannelID)
		return r.sendError(conn, "CHANNEL_NOT_FOUND", "channel members could not be resolved")
	}

	slog.Info("group commit relayed",
		"sender", conn.UserID,
		"channel", frame.ChannelID,
		"epoch", frame.Epoch,
	)
	return nil
}


func (r *Router) notifyOfflineRecipient(recipientUserID, channelID string, seqNum uint64) {
	if r.pushClient == nil || r.dispatcher == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := r.pushClient.GetPushTokens(ctx, &chatv1.GetPushTokensRequest{
		UserId: recipientUserID,
	})
	if err != nil {
		slog.Debug("failed to fetch push tokens for offline recipient", "recipient", recipientUserID, "error", err)
		return
	}

	for _, token := range resp.Tokens {
		r.dispatcher.Enqueue(push.PushNotification{
			DeviceID:  token.DeviceId,
			UserID:    recipientUserID,
			Platform:  push.Platform(strings.ToLower(token.Platform.String())),
			Token:     token.Token,
			Endpoint:  token.Endpoint,
			P256dh:    token.P256Dh,
			Auth:      token.Auth,
			ChannelID: channelID,
			Sequence:  seqNum,
			Timestamp: time.Now(),
		})
	}
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

	// Verify channel membership before returning message history
	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		if r.channelClient != nil && cleanID != "public" {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil && len(resp.GetMembers()) > 0 {
				isMember := false
				for _, m := range resp.GetMembers() {
					if m.GetUserId() == conn.UserID {
						isMember = true
						break
					}
				}
				if !isMember {
					return r.sendError(conn, "FORBIDDEN", "user is not a member of this channel")
				}
			}
		}
	}

	conversationID := getConversationID(conn.UserID, frame.ChannelID)
	bucket := time.Now().Format("2006-01")
	msgs, err := r.ledger.FetchMessages(ctx, conversationID, bucket, frame.Limit, frame.BeforeServerID)
	if err != nil {
		slog.Error("failed to fetch history", "error", err, "channel", frame.ChannelID, "conversation_id", conversationID)
		return r.sendError(conn, "FETCH_FAILED", "could not fetch message history")
	}

	var dtos []HistoryMessageDTO
	for _, m := range msgs {
		dtos = append(dtos, HistoryMessageDTO{
			ServerID:        m.MessageID,
			SequenceNum:     m.SequenceNum,
			SenderID:        m.SenderID,
			ClientMsgID:     m.ClientMsgID,
			CiphertextB64:   base64.StdEncoding.EncodeToString(m.EncryptedPayload),
			CreatedAtUnix:   m.CreatedAt.Unix(),
			EphemeralTTLSec: m.EphemeralTTLSec,
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
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string
		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(context.Background(), &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil {
				for _, m := range resp.GetMembers() {
					memberIDs = append(memberIDs, m.GetUserId())
				}
			}
		}
		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				if uid != conn.UserID {
					r.hub.SendToUser(uid, push)
				}
			}
		} else if frame.ChannelID == "chan_public" {
			r.hub.BroadcastAll(conn.UserID, push)
		}
	} else {
		r.hub.SendToUser(frame.ChannelID, push)
	}
	return nil
}

func (r *Router) handleReadReceipt(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame struct {
		Action      string `json:"action"`
		ChannelID   string `json:"channel_id"`
		ServerID    string `json:"server_id"`
		MessageID   string `json:"message_id"`
		SequenceNum int64  `json:"sequence_num"`
		ReceiptType string `json:"receipt_type"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil
	}
	if frame.ChannelID == "" {
		return nil
	}
	msgID := frame.ServerID
	if msgID == "" {
		msgID = frame.MessageID
	}
	receiptType := frame.ReceiptType
	if receiptType == "" {
		if frame.Action == "read_receipt" {
			receiptType = "read"
		} else {
			receiptType = "delivered"
		}
	}

	// Persist to ScyllaDB ledger if configured
	if r.ledger != nil && msgID != "" {
		conversationID := getConversationID(conn.UserID, frame.ChannelID)
		if err := r.ledger.UpdateReceipt(ctx, conversationID, conn.UserID, receiptType, msgID, frame.SequenceNum); err != nil {
			slog.Debug("failed to persist receipt in ledger", "error", err, "user", conn.UserID)
		}
	}

	receiptPush, _ := json.Marshal(map[string]any{
		"type":         "receipt",
		"channel_id":   frame.ChannelID,
		"user_id":      conn.UserID,
		"server_id":    msgID,
		"message_id":   msgID,
		"sequence_num": frame.SequenceNum,
		"receipt_type": receiptType,
		"timestamp":    time.Now().Unix(),
	})

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string
		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil {
				for _, m := range resp.GetMembers() {
					memberIDs = append(memberIDs, m.GetUserId())
				}
			}
		}
		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				if uid != conn.UserID {
					r.hub.SendToUser(uid, receiptPush)
				}
			}
		} else if frame.ChannelID == "chan_public" {
			r.hub.BroadcastAll(conn.UserID, receiptPush)
		}
	} else {
		// DM: send receipt to original sender
		r.hub.SendToUser(frame.ChannelID, receiptPush)
	}

	return nil
}

func (r *Router) handlePing(conn *ws.Conn) error {
	pong, _ := json.Marshal(map[string]string{"type": "pong"})
	r.hub.SendToUser(conn.UserID, pong)
	return nil
}

func (r *Router) handleCallSignal(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame CallSignalInboundFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse call_signal frame")
	}

	if frame.CallID == "" || frame.SignalType == "" {
		return r.sendError(conn, "MISSING_FIELDS", "call_id and signal_type are required")
	}

	pushPayload, err := json.Marshal(CallSignalPushFrame{
		Type:         "call_signal",
		SignalType:   frame.SignalType,
		CallID:       frame.CallID,
		ChannelID:    frame.ChannelID,
		SenderID:     conn.UserID,
		TargetUserID: frame.TargetUserID,
		CallType:     frame.CallType,
		SDP:          frame.SDP,
		Candidate:    frame.Candidate,
		ServerTime:   time.Now().Unix(),
	})
	if err != nil {
		return err
	}

	// 1. Group broadcast signals (group_join, group_leave, group_ping) sent to channel members
	if (frame.SignalType == "group_join" || frame.SignalType == "group_leave" || frame.SignalType == "group_ping") && frame.ChannelID != "" {
		if frame.ChannelID == "chan_public" || frame.ChannelID == "public" {
			r.hub.BroadcastAll(conn.UserID, pushPayload)
		} else if strings.HasPrefix(frame.ChannelID, "chan_") {
			cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
			var memberIDs []string
			if r.channelClient != nil {
				resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
					ChannelId: cleanID,
				})
				if err == nil {
					for _, m := range resp.GetMembers() {
						if m.GetUserId() != conn.UserID {
							memberIDs = append(memberIDs, m.GetUserId())
						}
					}
				}
			}

			if len(memberIDs) > 0 {
				for _, uid := range memberIDs {
					r.hub.SendToUser(uid, pushPayload)
				}
			}
		} else {
			// 1:1 direct channel broadcast
			r.hub.SendToUser(frame.ChannelID, pushPayload)
		}

		slog.Info("group call signal broadcast",
			"signal_type", frame.SignalType,
			"sender", conn.UserID,
			"channel", frame.ChannelID,
			"call_id", frame.CallID,
		)
		return nil
	}

	// 2. Direct peer-addressed signal (offer, answer, ice_candidate, hangup, reject)
	if frame.TargetUserID == "" {
		return r.sendError(conn, "MISSING_FIELDS", "target_user_id is required for direct call signals")
	}

	// If recipient is offline and this is an offer, inform caller immediately
	if frame.SignalType == "offer" && !r.hub.IsOnline(frame.TargetUserID) {
		slog.Info("call target is offline", "caller", conn.UserID, "target", frame.TargetUserID, "call_id", frame.CallID)
		offlineNotice, _ := json.Marshal(CallSignalPushFrame{
			Type:         "call_signal",
			SignalType:   "peer_offline",
			CallID:       frame.CallID,
			ChannelID:    frame.ChannelID,
			SenderID:     frame.TargetUserID,
			TargetUserID: conn.UserID,
			CallType:     frame.CallType,
			ServerTime:   time.Now().Unix(),
		})
		r.hub.SendToUser(conn.UserID, offlineNotice)
		return nil
	}

	r.hub.SendToUser(frame.TargetUserID, pushPayload)
	slog.Info("call signal relayed",
		"signal_type", frame.SignalType,
		"caller", conn.UserID,
		"target", frame.TargetUserID,
		"call_id", frame.CallID,
		"channel", frame.ChannelID,
	)
	return nil
}

func (r *Router) handleEphemeralSetting(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame EphemeralSettingFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse ephemeral_setting frame")
	}
	if frame.ChannelID == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id is required")
	}

	pushPayload, err := json.Marshal(EphemeralSettingPushFrame{
		Type:            "ephemeral_setting",
		ChannelID:       frame.ChannelID,
		EphemeralTTLSec: frame.EphemeralTTLSec,
		UpdatedBy:       conn.UserID,
		UpdatedAt:       time.Now().Unix(),
	})
	if err != nil {
		return err
	}

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string
		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil && len(resp.GetMembers()) > 0 {
				for _, m := range resp.GetMembers() {
					memberIDs = append(memberIDs, m.GetUserId())
				}
			}
		}

		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				r.hub.SendToUser(uid, pushPayload)
			}
		} else if frame.ChannelID == "chan_public" {
			r.hub.BroadcastAll("", pushPayload)
		}
	} else {
		// 1:1 conversation: send to recipient and back to sender
		r.hub.SendToUser(frame.ChannelID, pushPayload)
		if frame.ChannelID != conn.UserID {
			r.hub.SendToUser(conn.UserID, pushPayload)
		}
	}

	slog.Info("ephemeral setting updated",
		"channel", frame.ChannelID,
		"ttl_sec", frame.EphemeralTTLSec,
		"updated_by", conn.UserID,
	)
	return nil
}

func (r *Router) handleReaction(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame ReactionInboundFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse reaction frame")
	}
	targetID := frame.TargetID
	if targetID == "" {
		targetID = frame.TargetMsgID
	}
	if frame.ChannelID == "" || targetID == "" || frame.Emoji == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id, target_id, and emoji are required")
	}

	op := frame.Op
	if op == "" {
		op = "add"
	}

	pushPayload, err := json.Marshal(ReactionPushFrame{
		Type:        "reaction",
		ChannelID:   frame.ChannelID,
		TargetID:    targetID,
		TargetMsgID: targetID,
		SenderID:    conn.UserID,
		Emoji:       frame.Emoji,
		Op:          op,
		ServerTime:  time.Now().Unix(),
	})
	if err != nil {
		return err
	}

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string
		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil {
				for _, m := range resp.GetMembers() {
					memberIDs = append(memberIDs, m.GetUserId())
				}
			}
		}

		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				r.hub.SendToUser(uid, pushPayload)
			}
		} else if frame.ChannelID == "chan_public" {
			r.hub.BroadcastAll("", pushPayload)
		}
	} else {
		// 1:1 direct message: send to peer and echo back to sender
		r.hub.SendToUser(frame.ChannelID, pushPayload)
		if frame.ChannelID != conn.UserID {
			r.hub.SendToUser(conn.UserID, pushPayload)
		}
	}

	slog.Info("reaction relayed",
		"channel", frame.ChannelID,
		"target_id", frame.TargetID,
		"emoji", frame.Emoji,
		"op", op,
		"sender", conn.UserID,
	)
	return nil
}

func (r *Router) handleDeleteMessage(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame DeleteMessageInboundFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse delete_message frame")
	}
	messageID := frame.MessageID
	if messageID == "" {
		messageID = frame.ClientMsgID
	}
	if frame.ChannelID == "" || messageID == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id and message_id are required")
	}

	scope := frame.DeleteScope
	if scope == "" {
		scope = "everyone"
	}

	// 1. If delete_scope == "everyone", broadcast push frame to conversation participants
	if scope == "everyone" {
		pushPayload, err := json.Marshal(DeleteMessagePushFrame{
			Type:        "message_deleted",
			ChannelID:   frame.ChannelID,
			MessageID:   messageID,
			SenderID:    conn.UserID,
			DeleteScope: "everyone",
			ServerTime:  time.Now().Unix(),
		})
		if err != nil {
			return err
		}

		if strings.HasPrefix(frame.ChannelID, "chan_") {
			cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
			var memberIDs []string
			if r.channelClient != nil {
				resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
					ChannelId: cleanID,
				})
				if err == nil {
					for _, m := range resp.GetMembers() {
						memberIDs = append(memberIDs, m.GetUserId())
					}
				}
			}

			if len(memberIDs) > 0 {
				for _, uid := range memberIDs {
					r.hub.SendToUser(uid, pushPayload)
				}
			} else if frame.ChannelID == "chan_public" {
				r.hub.BroadcastAll("", pushPayload)
			}
		} else {
			// 1:1 direct message: send to peer and echo back to sender
			r.hub.SendToUser(frame.ChannelID, pushPayload)
			if frame.ChannelID != conn.UserID {
				r.hub.SendToUser(conn.UserID, pushPayload)
			}
		}
	}

	// 2. Always ACK the requester
	ackPayload, _ := json.Marshal(AckDeleteFrame{
		Type:        "ack_delete",
		MessageID:   messageID,
		ChannelID:   frame.ChannelID,
		DeleteScope: scope,
	})
	r.hub.SendToUser(conn.UserID, ackPayload)

	slog.Info("message deletion processed",
		"channel", frame.ChannelID,
		"message_id", messageID,
		"scope", scope,
		"sender", conn.UserID,
	)
	return nil
}

func (r *Router) handleEditMessage(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame EditMessageInboundFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse edit_message frame")
	}
	messageID := frame.MessageID
	if messageID == "" {
		messageID = frame.ClientMsgID
	}
	if frame.ChannelID == "" || messageID == "" || frame.CiphertextB64 == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id, message_id, and ciphertext_base64 are required")
	}

	serverTime := time.Now().Unix()

	// 1. Broadcast push frame to conversation participants
	pushPayload, err := json.Marshal(EditMessagePushFrame{
		Type:          "message_edited",
		ChannelID:     frame.ChannelID,
		MessageID:     messageID,
		SenderID:      conn.UserID,
		CiphertextB64: frame.CiphertextB64,
		ServerTime:    serverTime,
	})
	if err != nil {
		return err
	}

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string
		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil {
				for _, m := range resp.GetMembers() {
					memberIDs = append(memberIDs, m.GetUserId())
				}
			}
		}

		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				r.hub.SendToUser(uid, pushPayload)
			}
		} else if frame.ChannelID == "chan_public" {
			r.hub.BroadcastAll("", pushPayload)
		}
	} else {
		// 1:1 direct message: send to peer and echo back to sender
		r.hub.SendToUser(frame.ChannelID, pushPayload)
		if frame.ChannelID != conn.UserID {
			r.hub.SendToUser(conn.UserID, pushPayload)
		}
	}

	// 2. ACK the editor
	ackPayload, _ := json.Marshal(AckEditFrame{
		Type:       "ack_edit",
		MessageID:  messageID,
		ChannelID:  frame.ChannelID,
		ServerTime: serverTime,
	})
	r.hub.SendToUser(conn.UserID, ackPayload)

	slog.Info("message edit processed",
		"channel", frame.ChannelID,
		"message_id", messageID,
		"sender", conn.UserID,
	)
	return nil
}

func (r *Router) handlePinMessage(ctx context.Context, conn *ws.Conn, data []byte) error {
	var frame PinMessageInboundFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return r.sendError(conn, "INVALID_FRAME", "could not parse pin_message frame")
	}
	messageID := frame.MessageID
	if messageID == "" {
		messageID = frame.ClientMsgID
	}
	if frame.ChannelID == "" || messageID == "" {
		return r.sendError(conn, "MISSING_FIELDS", "channel_id and message_id are required")
	}

	op := frame.Op
	if op == "" {
		op = "pin"
	}
	if op != "pin" && op != "unpin" {
		op = "pin"
	}

	serverTime := time.Now().Unix()

	// 1. Broadcast push frame to conversation participants
	pushPayload, err := json.Marshal(PinMessagePushFrame{
		Type:       "message_pinned",
		ChannelID:  frame.ChannelID,
		MessageID:  messageID,
		SenderID:   conn.UserID,
		Op:         op,
		ServerTime: serverTime,
	})
	if err != nil {
		return err
	}

	if strings.HasPrefix(frame.ChannelID, "chan_") {
		cleanID := strings.TrimPrefix(frame.ChannelID, "chan_")
		var memberIDs []string
		if r.channelClient != nil {
			resp, err := r.channelClient.GetChannelMembers(ctx, &chatv1.GetChannelMembersRequest{
				ChannelId: cleanID,
			})
			if err == nil {
				for _, m := range resp.GetMembers() {
					memberIDs = append(memberIDs, m.GetUserId())
				}
			}
		}

		if len(memberIDs) > 0 {
			for _, uid := range memberIDs {
				r.hub.SendToUser(uid, pushPayload)
			}
		} else if frame.ChannelID == "chan_public" {
			r.hub.BroadcastAll("", pushPayload)
		}
	} else {
		// 1:1 direct message: send to peer and echo back to sender
		r.hub.SendToUser(frame.ChannelID, pushPayload)
		if frame.ChannelID != conn.UserID {
			r.hub.SendToUser(conn.UserID, pushPayload)
		}
	}

	// 2. ACK the requester
	ackPayload, _ := json.Marshal(AckPinFrame{
		Type:       "ack_pin",
		MessageID:  messageID,
		ChannelID:  frame.ChannelID,
		Op:         op,
		ServerTime: serverTime,
	})
	r.hub.SendToUser(conn.UserID, ackPayload)

	slog.Info("message pin processed",
		"channel", frame.ChannelID,
		"message_id", messageID,
		"op", op,
		"sender", conn.UserID,
	)
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

// getConversationID derives a canonical conversation partition key.
// For public channels (chan_*), it returns the channel ID directly.
// For 1:1 direct messages, it sorts user IDs to ensure both peers read/write the same Scylla partition.
func getConversationID(currentUserID, channelID string) string {
	if strings.HasPrefix(channelID, "chan_") {
		return channelID
	}
	if currentUserID < channelID {
		return "dm:" + currentUserID + ":" + channelID
	}
	return "dm:" + channelID + ":" + currentUserID
}
