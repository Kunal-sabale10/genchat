package handler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gocql/gocql"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/msgledger/internal/store"
)

type mockStore struct {
	dedupRecord   *store.DedupRecord
	dedupErr      error
	insertMsgErr  error
	insertDedupErr error
	messages      []*store.StoredMessage
	fetchMsgsErr  error
	upsertRcptErr error
	receipts      []*store.Receipt
	getRcptsErr   error
	recordAuthErr error
	authorID      string
	authorTime    time.Time
	getAuthorErr  error
	recordEvtErr  error
	events        []*store.MessageEvent
	fetchEvtsErr  error
}

func (m *mockStore) GetDedup(ctx context.Context, conversationID, clientMsgID string) (*store.DedupRecord, error) {
	return m.dedupRecord, m.dedupErr
}

func (m *mockStore) InsertMessage(ctx context.Context, msg *store.StoredMessage) error {
	return m.insertMsgErr
}

func (m *mockStore) InsertDedup(ctx context.Context, conversationID, clientMsgID string, messageID gocql.UUID, sequenceNum int64, ttlSec int64) error {
	return m.insertDedupErr
}

func (m *mockStore) FetchMessages(ctx context.Context, conversationID, bucket string, limit int, beforeID *uuid.UUID) ([]*store.StoredMessage, error) {
	return m.messages, m.fetchMsgsErr
}

func (m *mockStore) UpsertReceipt(ctx context.Context, conversationID, userID string, delID, readID *uuid.UUID, delSeq, readSeq int64) error {
	return m.upsertRcptErr
}

func (m *mockStore) GetReceipts(ctx context.Context, conversationID string) ([]*store.Receipt, error) {
	return m.receipts, m.getRcptsErr
}

func (m *mockStore) RecordAuthor(ctx context.Context, conversationID, messageID, senderID string) error {
	return m.recordAuthErr
}

func (m *mockStore) GetAuthor(ctx context.Context, conversationID, messageID string) (string, time.Time, error) {
	return m.authorID, m.authorTime, m.getAuthorErr
}

func (m *mockStore) RecordEvent(ctx context.Context, conversationID, messageID, eventType, actorID string, newCiphertext []byte) error {
	return m.recordEvtErr
}

func (m *mockStore) FetchEvents(ctx context.Context, conversationID, messageID string) ([]*store.MessageEvent, error) {
	return m.events, m.fetchEvtsErr
}

type mockSeqGen struct {
	nextSeq int64
	nextErr error
}

func (m *mockSeqGen) Next(ctx context.Context, conversationID string) (int64, error) {
	return m.nextSeq, m.nextErr
}

func (m *mockSeqGen) Current(ctx context.Context, conversationID string) (int64, error) {
	return m.nextSeq, m.nextErr
}

func TestHandler_StoreMessage(t *testing.T) {
	t.Run("NewMessage_Success", func(t *testing.T) {
		s := &mockStore{}
		sg := &mockSeqGen{nextSeq: 101}
		h := NewLedgerHandler(s, sg)

		resp, err := h.StoreMessage(context.Background(), &chatv1.StoreMessageRequest{
			ConversationId:   "conv_1",
			SenderId:         "usr_alice",
			ClientMsgId:      "cmsg_1",
			EncryptedPayload: []byte("secret"),
			EphemeralTtlSec:  60,
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp.Deduplicated {
			t.Errorf("expected deduplicated=false")
		}
		if resp.Message.SequenceNum != 101 {
			t.Errorf("expected seq 101, got %d", resp.Message.SequenceNum)
		}
		if resp.Message.EphemeralTtlSec != 60 {
			t.Errorf("expected ttl 60, got %d", resp.Message.EphemeralTtlSec)
		}
	})

	t.Run("DeduplicatedMessage", func(t *testing.T) {
		origID := uuid.New()
		s := &mockStore{
			dedupRecord: &store.DedupRecord{
				MessageID:   origID,
				SequenceNum: 55,
				CreatedAt:   time.Now(),
			},
		}
		sg := &mockSeqGen{nextSeq: 999}
		h := NewLedgerHandler(s, sg)

		resp, err := h.StoreMessage(context.Background(), &chatv1.StoreMessageRequest{
			ConversationId: "conv_1",
			SenderId:       "usr_alice",
			ClientMsgId:    "cmsg_1",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !resp.Deduplicated {
			t.Errorf("expected deduplicated=true")
		}
		if resp.Message.SequenceNum != 55 {
			t.Errorf("expected seq 55, got %d", resp.Message.SequenceNum)
		}
	})

	t.Run("SequenceGeneratorError", func(t *testing.T) {
		s := &mockStore{}
		sg := &mockSeqGen{nextErr: errors.New("redis connection refused")}
		h := NewLedgerHandler(s, sg)

		_, err := h.StoreMessage(context.Background(), &chatv1.StoreMessageRequest{
			ConversationId: "conv_1",
			ClientMsgId:    "cmsg_1",
		})
		if err == nil {
			t.Fatalf("expected error, got nil")
		}
		if status.Code(err) != codes.Internal {
			t.Errorf("expected Internal code, got: %v", status.Code(err))
		}
	})
}

func TestHandler_AuthorMethods(t *testing.T) {
	tests := []struct {
		name         string
		action       string // "record" or "get"
		convID       string
		msgID        string
		senderID     string
		mockAuthor   string
		mockErr      error
		expectedCode codes.Code
	}{
		{
			name:         "RecordAuthor_Success",
			action:       "record",
			convID:       "conv_1",
			msgID:        "msg_1",
			senderID:     "usr_alice",
			expectedCode: codes.OK,
		},
		{
			name:         "RecordAuthor_MissingFields",
			action:       "record",
			convID:       "conv_1",
			msgID:        "",
			senderID:     "usr_alice",
			expectedCode: codes.InvalidArgument,
		},
		{
			name:         "RecordAuthor_StoreError",
			action:       "record",
			convID:       "conv_1",
			msgID:        "msg_1",
			senderID:     "usr_alice",
			mockErr:      errors.New("db error"),
			expectedCode: codes.Internal,
		},
		{
			name:         "GetAuthor_Success",
			action:       "get",
			convID:       "conv_1",
			msgID:        "msg_1",
			mockAuthor:   "usr_alice",
			expectedCode: codes.OK,
		},
		{
			name:         "GetAuthor_MissingFields",
			action:       "get",
			convID:       "",
			msgID:        "msg_1",
			expectedCode: codes.InvalidArgument,
		},
		{
			name:         "GetAuthor_NotFound",
			action:       "get",
			convID:       "conv_1",
			msgID:        "msg_1",
			mockAuthor:   "", // empty author
			expectedCode: codes.NotFound,
		},
		{
			name:         "GetAuthor_StoreError",
			action:       "get",
			convID:       "conv_1",
			msgID:        "msg_1",
			mockErr:      errors.New("connection reset"),
			expectedCode: codes.Internal,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &mockStore{
				authorID:      tt.mockAuthor,
				authorTime:    time.Now(),
				recordAuthErr: tt.mockErr,
				getAuthorErr:  tt.mockErr,
			}
			h := NewLedgerHandler(s, nil)

			if tt.action == "record" {
				_, err := h.RecordMessageAuthor(context.Background(), &chatv1.RecordMessageAuthorRequest{
					ConversationId: tt.convID,
					MessageId:      tt.msgID,
					SenderId:       tt.senderID,
				})
				if status.Code(err) != tt.expectedCode {
					t.Fatalf("expected code %v, got: %v (err: %v)", tt.expectedCode, status.Code(err), err)
				}
			} else {
				resp, err := h.GetMessageAuthor(context.Background(), &chatv1.GetMessageAuthorRequest{
					ConversationId: tt.convID,
					MessageId:      tt.msgID,
				})
				if status.Code(err) != tt.expectedCode {
					t.Fatalf("expected code %v, got: %v (err: %v)", tt.expectedCode, status.Code(err), err)
				}
				if tt.expectedCode == codes.OK && resp.SenderId != tt.mockAuthor {
					t.Fatalf("expected author %s, got: %s", tt.mockAuthor, resp.SenderId)
				}
			}
		})
	}
}

func TestHandler_EventMethods(t *testing.T) {
	tests := []struct {
		name         string
		action       string // "record" or "fetch"
		convID       string
		msgID        string
		eventType    string
		mockEvents   []*store.MessageEvent
		mockErr      error
		expectedCode codes.Code
	}{
		{
			name:         "RecordEvent_Success",
			action:       "record",
			convID:       "conv_1",
			msgID:        "msg_1",
			eventType:    "delete",
			expectedCode: codes.OK,
		},
		{
			name:         "RecordEvent_MissingEventType",
			action:       "record",
			convID:       "conv_1",
			msgID:        "msg_1",
			eventType:    "",
			expectedCode: codes.InvalidArgument,
		},
		{
			name:         "FetchEvents_Success",
			action:       "fetch",
			convID:       "conv_1",
			msgID:        "msg_1",
			mockEvents: []*store.MessageEvent{
				{
					ConversationID: "conv_1",
					MessageID:      "msg_1",
					EventType:      "edit",
					ActorID:        "usr_alice",
					CreatedAt:      time.Now(),
				},
			},
			expectedCode: codes.OK,
		},
		{
			name:         "FetchEvents_MissingConversationID",
			action:       "fetch",
			convID:       "",
			expectedCode: codes.InvalidArgument,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &mockStore{
				events:       tt.mockEvents,
				recordEvtErr: tt.mockErr,
				fetchEvtsErr: tt.mockErr,
			}
			h := NewLedgerHandler(s, nil)

			if tt.action == "record" {
				_, err := h.RecordMessageEvent(context.Background(), &chatv1.RecordMessageEventRequest{
					ConversationId: tt.convID,
					MessageId:      tt.msgID,
					EventType:      tt.eventType,
				})
				if status.Code(err) != tt.expectedCode {
					t.Fatalf("expected code %v, got: %v", tt.expectedCode, status.Code(err))
				}
			} else {
				resp, err := h.FetchMessageEvents(context.Background(), &chatv1.FetchMessageEventsRequest{
					ConversationId: tt.convID,
					MessageId:      tt.msgID,
				})
				if status.Code(err) != tt.expectedCode {
					t.Fatalf("expected code %v, got: %v", tt.expectedCode, status.Code(err))
				}
				if tt.expectedCode == codes.OK && len(resp.Events) != len(tt.mockEvents) {
					t.Fatalf("expected %d events, got: %d", len(tt.mockEvents), len(resp.Events))
				}
			}
		})
	}
}

func TestHandler_UpdateReceipt(t *testing.T) {
	validUUID := uuid.New().String()

	tests := []struct {
		name         string
		convID       string
		userID       string
		rcptType     string
		msgID        string
		seq          int64
		mockErr      error
		expectedCode codes.Code
	}{
		{
			name:         "Delivered_Success",
			convID:       "conv_1",
			userID:       "usr_bob",
			rcptType:     "delivered",
			msgID:        validUUID,
			seq:          10,
			expectedCode: codes.OK,
		},
		{
			name:         "Read_Success",
			convID:       "conv_1",
			userID:       "usr_bob",
			rcptType:     "read",
			msgID:        validUUID,
			seq:          10,
			expectedCode: codes.OK,
		},
		{
			name:         "InvalidMessageUUID",
			convID:       "conv_1",
			userID:       "usr_bob",
			rcptType:     "read",
			msgID:        "not-a-uuid",
			expectedCode: codes.InvalidArgument,
		},
		{
			name:         "InvalidReceiptType",
			convID:       "conv_1",
			userID:       "usr_bob",
			rcptType:     "unknown_receipt",
			msgID:        validUUID,
			expectedCode: codes.InvalidArgument,
		},
		{
			name:         "StoreError",
			convID:       "conv_1",
			userID:       "usr_bob",
			rcptType:     "delivered",
			msgID:        validUUID,
			mockErr:      errors.New("scylla write error"),
			expectedCode: codes.Internal,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &mockStore{upsertRcptErr: tt.mockErr}
			h := NewLedgerHandler(s, nil)

			_, err := h.UpdateReceipt(context.Background(), &chatv1.UpdateReceiptRequest{
				ConversationId: tt.convID,
				UserId:         tt.userID,
				ReceiptType:    tt.rcptType,
				MessageId:      tt.msgID,
				SequenceNum:    tt.seq,
			})
			if status.Code(err) != tt.expectedCode {
				t.Fatalf("expected code %v, got: %v (err: %v)", tt.expectedCode, status.Code(err), err)
			}
		})
	}
}
