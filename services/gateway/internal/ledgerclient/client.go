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
// the same (conversation_id, client_msg_id) gets back Deduplicated=true
// (the ledger signals this via a gRPC AlreadyExists status, not a response
// field — see services/msgledger/internal/handler/handler.go's
// StoreMessageDirect) rather than erroring or double-writing. Note: on a
// dedup hit we don't have the original message_id/sequence_num — the
// ledger's AlreadyExists error doesn't carry them. Until that's added,
// callers get Deduplicated=true with an empty MessageID.
func (c *Client) StoreMessage(ctx context.Context, conversationID, senderID, clientMsgID string, encryptedPayload, senderRatchetKey []byte, messageIndex uint32) (*StoreMessageResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.rpc.StoreMessage(ctx, &chatv1.StoreMessageRequest{
		ConversationId:   conversationID,
		SenderId:         senderID,
		ClientMsgId:      clientMsgID,
		EncryptedPayload: encryptedPayload,
		SenderRatchetKey: senderRatchetKey,
		MessageIndex:     messageIndex,
	})
	if err != nil {
		if status.Code(err) == codes.AlreadyExists {
			return &StoreMessageResult{Deduplicated: true}, nil
		}
		return nil, fmt.Errorf("ledgerclient: StoreMessage: %w", err)
	}

	return &StoreMessageResult{
		MessageID:   resp.GetMessage().GetMessageId(),
		SequenceNum: resp.GetMessage().GetSequenceNum(),
	}, nil
}
