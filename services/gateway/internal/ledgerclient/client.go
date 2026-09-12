// Package ledgerclient dials the msgledger gRPC service and exposes the
// subset of LedgerService the gateway needs on the hot message-send path.
package ledgerclient

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
)

// Client wraps a gRPC connection to msgledger.
type Client struct {
	conn *grpc.ClientConn
	rpc  chatv1.LedgerServiceClient
}

// Dial connects to msgledger at addr (e.g. "ledger:50052"). grpc.NewClient
// itself is lazy (it doesn't error even if the target is unreachable), so
// we explicitly poll for READY here — the caller passes a deadline via ctx,
// and startup failures surface immediately as a Dial error instead of
// silently deferring to the first message send.
func Dial(ctx context.Context, addr string) (*Client, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("ledgerclient: dial %s: %w", addr, err)
	}

	conn.Connect()
	for {
		state := conn.GetState()
		if state == connectivity.Ready {
			break
		}
		if !conn.WaitForStateChange(ctx, state) {
			conn.Close()
			return nil, fmt.Errorf("ledgerclient: %s did not become ready: %w", addr, ctx.Err())
		}
	}

	return &Client{conn: conn, rpc: chatv1.NewLedgerServiceClient(conn)}, nil
}

func (c *Client) Close() error {
	return c.conn.Close()
}

// StoreMessageResult is the durable identity assigned to a persisted message.
type StoreMessageResult struct {
	MessageID    string
	SequenceNum  int64
	Deduplicated bool
}

// StoreMessage persists a 1:1 message synchronously and returns the durable
// message ID + sequence number the ledger assigned. Idempotent: a retry with
// the same (conversation_id, client_msg_id) gets back Deduplicated=true along
// with the original message_id and sequence_num assigned on first store.
func (c *Client) StoreMessage(ctx context.Context, conversationID, senderID, clientMsgID string, encryptedPayload, senderRatchetKey []byte, messageIndex uint32, ephemeralTTLSec int64) (*StoreMessageResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.rpc.StoreMessage(ctx, &chatv1.StoreMessageRequest{
		ConversationId:   conversationID,
		SenderId:         senderID,
		ClientMsgId:      clientMsgID,
		EncryptedPayload: encryptedPayload,
		SenderRatchetKey: senderRatchetKey,
		MessageIndex:     messageIndex,
		EphemeralTtlSec:  ephemeralTTLSec,
	})
	if err != nil {
		if status.Code(err) == codes.AlreadyExists {
			return &StoreMessageResult{Deduplicated: true}, nil
		}
		return nil, fmt.Errorf("ledgerclient: StoreMessage: %w", err)
	}

	return &StoreMessageResult{
		MessageID:    resp.GetMessage().GetMessageId(),
		SequenceNum:  resp.GetMessage().GetSequenceNum(),
		Deduplicated: resp.GetDeduplicated(),
	}, nil
}

// LedgerMessage represents a message fetched from the ledger store.
type LedgerMessage struct {
	ConversationID   string    `json:"conversation_id"`
	MessageID        string    `json:"message_id"`
	SequenceNum      int64     `json:"sequence_num"`
	SenderID         string    `json:"sender_id"`
	ClientMsgID      string    `json:"client_msg_id"`
	EncryptedPayload []byte    `json:"encrypted_payload"`
	CreatedAt        time.Time `json:"created_at"`
	EphemeralTTLSec  int64     `json:"ephemeral_ttl_sec,omitempty"`
}

// FetchMessages retrieves historical messages for a conversation/channel.
func (c *Client) FetchMessages(ctx context.Context, conversationID, bucket string, limit int32, beforeMessageID string) ([]*LedgerMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if bucket == "" {
		bucket = time.Now().Format("2006-01")
	}
	if limit <= 0 {
		limit = 50
	}

	resp, err := c.rpc.FetchMessages(ctx, &chatv1.FetchMessagesRequest{
		ConversationId:  conversationID,
		Bucket:          bucket,
		Limit:           limit,
		BeforeMessageId: beforeMessageID,
	})
	if err != nil {
		return nil, fmt.Errorf("ledgerclient: FetchMessages: %w", err)
	}

	var msgs []*LedgerMessage
	for _, m := range resp.GetMessages() {
		var createdAt time.Time
		if m.GetCreatedAt() != nil {
			createdAt = m.GetCreatedAt().AsTime()
		}
		msgs = append(msgs, &LedgerMessage{
			ConversationID:   m.GetConversationId(),
			MessageID:        m.GetMessageId(),
			SequenceNum:      m.GetSequenceNum(),
			SenderID:         m.GetSenderId(),
			ClientMsgID:      m.GetClientMsgId(),
			EncryptedPayload: m.GetEncryptedPayload(),
			CreatedAt:        createdAt,
			EphemeralTTLSec:  m.GetEphemeralTtlSec(),
		})
	}
	return msgs, nil
}

// UpdateReceipt records a message delivery or read state in the ledger durable store.
func (c *Client) UpdateReceipt(ctx context.Context, conversationID, userID, receiptType, messageID string, sequenceNum int64) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := c.rpc.UpdateReceipt(ctx, &chatv1.UpdateReceiptRequest{
		ConversationId: conversationID,
		UserId:         userID,
		ReceiptType:    receiptType,
		MessageId:      messageID,
		SequenceNum:    sequenceNum,
	})
	if err != nil {
		return fmt.Errorf("ledgerclient: UpdateReceipt: %w", err)
	}
	return nil
}

// RecordMessageAuthor registers the original author of a message in msgledger.
func (c *Client) RecordMessageAuthor(ctx context.Context, conversationID, messageID, senderID string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := c.rpc.RecordMessageAuthor(ctx, &chatv1.RecordMessageAuthorRequest{
		ConversationId: conversationID,
		MessageId:      messageID,
		SenderId:       senderID,
	})
	if err != nil {
		return fmt.Errorf("ledgerclient: RecordMessageAuthor: %w", err)
	}
	return nil
}

// GetMessageAuthor queries the original author of a message from msgledger.
func (c *Client) GetMessageAuthor(ctx context.Context, conversationID, messageID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	resp, err := c.rpc.GetMessageAuthor(ctx, &chatv1.GetMessageAuthorRequest{
		ConversationId: conversationID,
		MessageId:      messageID,
	})
	if err != nil {
		return "", err
	}
	return resp.GetSenderId(), nil
}

// RecordMessageEvent records a deletion, edit, or pin event in msgledger.
func (c *Client) RecordMessageEvent(ctx context.Context, conversationID, messageID, eventType, actorID string, newCiphertext []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := c.rpc.RecordMessageEvent(ctx, &chatv1.RecordMessageEventRequest{
		ConversationId: conversationID,
		MessageId:      messageID,
		EventType:      eventType,
		ActorId:        actorID,
		NewCiphertext:  newCiphertext,
	})
	if err != nil {
		return fmt.Errorf("ledgerclient: RecordMessageEvent: %w", err)
	}
	return nil
}

// FetchMessageEvents fetches recent message events (deletions, edits, pins) for a conversation.
func (c *Client) FetchMessageEvents(ctx context.Context, conversationID, messageID string) ([]*chatv1.MessageEventItem, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.rpc.FetchMessageEvents(ctx, &chatv1.FetchMessageEventsRequest{
		ConversationId: conversationID,
		MessageId:      messageID,
	})
	if err != nil {
		return nil, fmt.Errorf("ledgerclient: FetchMessageEvents: %w", err)
	}
	return resp.GetEvents(), nil
}


