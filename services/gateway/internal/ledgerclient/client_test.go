package ledgerclient

import (
	"context"
	"errors"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
)

type mockLedgerRPC struct {
	chatv1.LedgerServiceClient
	storeResp  *chatv1.StoreMessageResponse
	storeErr   error
	fetchResp  *chatv1.FetchMessagesResponse
	fetchErr   error
	authorResp *chatv1.GetMessageAuthorResponse
	authorErr  error
	receiptErr error
	recAuthErr error
	eventErr   error
	eventsResp *chatv1.FetchMessageEventsResponse
	eventsErr  error
}

func (m *mockLedgerRPC) StoreMessage(ctx context.Context, in *chatv1.StoreMessageRequest, opts ...grpc.CallOption) (*chatv1.StoreMessageResponse, error) {
	if m.storeErr != nil {
		return nil, m.storeErr
	}
	return m.storeResp, nil
}

func (m *mockLedgerRPC) FetchMessages(ctx context.Context, in *chatv1.FetchMessagesRequest, opts ...grpc.CallOption) (*chatv1.FetchMessagesResponse, error) {
	if m.fetchErr != nil {
		return nil, m.fetchErr
	}
	return m.fetchResp, nil
}

func (m *mockLedgerRPC) UpdateReceipt(ctx context.Context, in *chatv1.UpdateReceiptRequest, opts ...grpc.CallOption) (*chatv1.UpdateReceiptResponse, error) {
	if m.receiptErr != nil {
		return nil, m.receiptErr
	}
	return &chatv1.UpdateReceiptResponse{}, nil
}

func (m *mockLedgerRPC) RecordMessageAuthor(ctx context.Context, in *chatv1.RecordMessageAuthorRequest, opts ...grpc.CallOption) (*chatv1.RecordMessageAuthorResponse, error) {
	if m.recAuthErr != nil {
		return nil, m.recAuthErr
	}
	return &chatv1.RecordMessageAuthorResponse{}, nil
}

func (m *mockLedgerRPC) GetMessageAuthor(ctx context.Context, in *chatv1.GetMessageAuthorRequest, opts ...grpc.CallOption) (*chatv1.GetMessageAuthorResponse, error) {
	if m.authorErr != nil {
		return nil, m.authorErr
	}
	return m.authorResp, nil
}

func (m *mockLedgerRPC) RecordMessageEvent(ctx context.Context, in *chatv1.RecordMessageEventRequest, opts ...grpc.CallOption) (*chatv1.RecordMessageEventResponse, error) {
	if m.eventErr != nil {
		return nil, m.eventErr
	}
	return &chatv1.RecordMessageEventResponse{}, nil
}

func (m *mockLedgerRPC) FetchMessageEvents(ctx context.Context, in *chatv1.FetchMessageEventsRequest, opts ...grpc.CallOption) (*chatv1.FetchMessageEventsResponse, error) {
	if m.eventsErr != nil {
		return nil, m.eventsErr
	}
	return m.eventsResp, nil
}

func TestStoreMessage(t *testing.T) {
	t.Run("Success", func(t *testing.T) {
		mock := &mockLedgerRPC{
			storeResp: &chatv1.StoreMessageResponse{
				Message: &chatv1.StoredMessageResponse{
					MessageId:   "msg_1",
					SequenceNum: 42,
				},
				Deduplicated: false,
			},
		}
		client := NewTestClient(mock)
		res, err := client.StoreMessage(context.Background(), "conv_1", "user_1", "client_1", []byte("payload"), []byte("ratchet"), 1, 0)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.MessageID != "msg_1" || res.SequenceNum != 42 || res.Deduplicated {
			t.Fatalf("unexpected result: %+v", res)
		}
	})

	t.Run("Deduplicated_AlreadyExists", func(t *testing.T) {
		mock := &mockLedgerRPC{
			storeErr: status.Error(codes.AlreadyExists, "already exists"),
		}
		client := NewTestClient(mock)
		res, err := client.StoreMessage(context.Background(), "conv_1", "user_1", "client_1", []byte("payload"), []byte("ratchet"), 1, 0)
		if err != nil {
			t.Fatalf("expected nil error on AlreadyExists, got: %v", err)
		}
		if !res.Deduplicated {
			t.Fatalf("expected Deduplicated=true, got: %+v", res)
		}
	})

	t.Run("GenericError", func(t *testing.T) {
		mock := &mockLedgerRPC{
			storeErr: errors.New("connection failed"),
		}
		client := NewTestClient(mock)
		_, err := client.StoreMessage(context.Background(), "conv_1", "user_1", "client_1", []byte("payload"), []byte("ratchet"), 1, 0)
		if err == nil {
			t.Fatalf("expected error, got nil")
		}
	})
}

func TestFetchMessages(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	mock := &mockLedgerRPC{
		fetchResp: &chatv1.FetchMessagesResponse{
			Messages: []*chatv1.StoredMessageResponse{
				{
					ConversationId:   "conv_1",
					MessageId:        "msg_1",
					SequenceNum:      1,
					SenderId:         "user_1",
					ClientMsgId:      "cmsg_1",
					EncryptedPayload: []byte("enc"),
					CreatedAt:        timestamppb.New(now),
					EphemeralTtlSec:  60,
				},
			},
		},
	}
	client := NewTestClient(mock)
	msgs, err := client.FetchMessages(context.Background(), "conv_1", "", 0, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].MessageID != "msg_1" || msgs[0].EphemeralTTLSec != 60 {
		t.Fatalf("unexpected message: %+v", msgs[0])
	}
	if !msgs[0].CreatedAt.Equal(now) {
		t.Fatalf("expected createdAt %v, got %v", now, msgs[0].CreatedAt)
	}
}

func TestAuthorAndEvents(t *testing.T) {
	t.Run("GetAuthor_Success", func(t *testing.T) {
		mock := &mockLedgerRPC{
			authorResp: &chatv1.GetMessageAuthorResponse{SenderId: "user_author"},
		}
		client := NewTestClient(mock)
		author, err := client.GetMessageAuthor(context.Background(), "conv_1", "msg_1")
		if err != nil || author != "user_author" {
			t.Fatalf("expected user_author, got: %s, err: %v", author, err)
		}
	})

	t.Run("RecordEvent_Success", func(t *testing.T) {
		mock := &mockLedgerRPC{}
		client := NewTestClient(mock)
		err := client.RecordMessageEvent(context.Background(), "conv_1", "msg_1", "delete", "user_1", nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("FetchEvents_Success", func(t *testing.T) {
		mock := &mockLedgerRPC{
			eventsResp: &chatv1.FetchMessageEventsResponse{
				Events: []*chatv1.MessageEventItem{
					{
						ConversationId: "conv_1",
						MessageId:      "msg_1",
						EventType:      "delete",
						ActorId:        "user_1",
					},
				},
			},
		}
		client := NewTestClient(mock)
		events, err := client.FetchMessageEvents(context.Background(), "conv_1", "msg_1")
		if err != nil || len(events) != 1 {
			t.Fatalf("expected 1 event, got: %+v, err: %v", events, err)
		}
	})
}
