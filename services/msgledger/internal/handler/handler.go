package handler

import (
	"context"
	"time"

	"github.com/gocql/gocql"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/genchat/services/msgledger/internal/sequence"
	"github.com/genchat/services/msgledger/internal/store"
)

type LedgerHandler struct {
	store  *store.ScyllaStore
	seqGen *sequence.Generator
}

func NewLedgerHandler(s *store.ScyllaStore, sg *sequence.Generator) *LedgerHandler {
	return &LedgerHandler{store: s, seqGen: sg}
}

func (h *LedgerHandler) Register(s *grpc.Server) {
	// Register the protobuf service here
}

func (h *LedgerHandler) StoreMessage(ctx context.Context, msg *store.Message) (*store.StoredMessage, error) {
	exists, err := h.store.CheckDedup(ctx, msg.ConversationID, msg.ClientMsgID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to check dedup: %v", err)
	}
	if exists {
		return nil, status.Errorf(codes.AlreadyExists, "message already processed")
	}

	seq, err := h.seqGen.Next(ctx, msg.ConversationID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get sequence number: %v", err)
	}

	now := time.Now()
	msgID, _ := uuid.NewV7()
	bucket := now.Format("2006-01")

	storedMsg := &store.StoredMessage{
		ConversationID:   msg.ConversationID,
		Bucket:           bucket,
		MessageID:        msgID,
		SequenceNum:      seq,
		SenderID:         msg.SenderID,
		ClientMsgID:      msg.ClientMsgID,
		EncryptedPayload: msg.EncryptedPayload,
		SenderRatchetKey: msg.SenderRatchetKey,
		MessageIndex:     msg.MessageIndex,
		CreatedAt:        now,
	}

	if err := h.store.InsertMessage(ctx, storedMsg); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to insert message: %v", err)
	}

	gocqlMsgID, _ := gocql.ParseUUID(msgID.String())
	if err := h.store.InsertDedup(ctx, msg.ConversationID, msg.ClientMsgID, gocqlMsgID); err != nil {
		// Log error but proceed
	}

	return storedMsg, nil
}

func (h *LedgerHandler) FetchMessages(ctx context.Context, conversationID string, bucket string, limit int, beforeMessageID *uuid.UUID) ([]*store.StoredMessage, error) {
	msgs, err := h.store.FetchMessages(ctx, conversationID, bucket, limit, beforeMessageID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to fetch messages: %v", err)
	}
	return msgs, nil
}

func (h *LedgerHandler) UpdateReceipt(ctx context.Context, conversationID, userID string, receiptType string, messageID uuid.UUID, seq int64) error {
	var delID, readID *uuid.UUID
	var delSeq, readSeq int64
	
	if receiptType == "delivered" {
		delID = &messageID
		delSeq = seq
	} else if receiptType == "read" {
		readID = &messageID
		readSeq = seq
	} else {
		return status.Errorf(codes.InvalidArgument, "invalid receipt type")
	}
	
	if err := h.store.UpsertReceipt(ctx, conversationID, userID, delID, readID, delSeq, readSeq); err != nil {
		return status.Errorf(codes.Internal, "failed to update receipt: %v", err)
	}
	return nil
}

func (h *LedgerHandler) GetReceipts(ctx context.Context, conversationID string) ([]*store.Receipt, error) {
	receipts, err := h.store.GetReceipts(ctx, conversationID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get receipts: %v", err)
	}
	return receipts, nil
}
