package handler

import (
	"context"
	"time"

	"github.com/gocql/gocql"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/msgledger/internal/sequence"
	"github.com/genchat/services/msgledger/internal/store"
)

type LedgerHandler struct {
	chatv1.UnimplementedLedgerServiceServer
	store  *store.ScyllaStore
	seqGen *sequence.Generator
}

func NewLedgerHandler(s *store.ScyllaStore, sg *sequence.Generator) *LedgerHandler {
	return &LedgerHandler{store: s, seqGen: sg}
}

func (h *LedgerHandler) Register(s *grpc.Server) {
	chatv1.RegisterLedgerServiceServer(s, h)
}

func (h *LedgerHandler) StoreMessage(ctx context.Context, req *chatv1.StoreMessageRequest) (*chatv1.StoreMessageResponse, error) {
	msg := &store.Message{
		ConversationID:   req.ConversationId,
		SenderID:         req.SenderId,
		ClientMsgID:      req.ClientMsgId,
		EncryptedPayload: req.EncryptedPayload,
		SenderRatchetKey: req.SenderRatchetKey,
		MessageIndex:     int(req.MessageIndex),
	}

	storedMsg, err := h.StoreMessageDirect(ctx, msg)
	if err != nil {
		return nil, err
	}

	return &chatv1.StoreMessageResponse{
		Message: &chatv1.StoredMessageResponse{
			ConversationId:   storedMsg.ConversationID,
			MessageId:        storedMsg.MessageID.String(),
			SequenceNum:      storedMsg.SequenceNum,
			SenderId:         storedMsg.SenderID,
			ClientMsgId:      storedMsg.ClientMsgID,
			EncryptedPayload: storedMsg.EncryptedPayload,
			SenderRatchetKey: storedMsg.SenderRatchetKey,
			MessageIndex:     uint32(storedMsg.MessageIndex),
			CreatedAt:        timestamppb.New(storedMsg.CreatedAt),
		},
	}, nil
}

func (h *LedgerHandler) StoreMessageDirect(ctx context.Context, msg *store.Message) (*store.StoredMessage, error) {
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
	msgID, err := uuid.NewUUID()
	if err != nil {
		tID := gocql.TimeUUID()
		msgID, _ = uuid.Parse(tID.String())
	}
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

func (h *LedgerHandler) FetchMessages(ctx context.Context, req *chatv1.FetchMessagesRequest) (*chatv1.FetchMessagesResponse, error) {
	var beforeID *uuid.UUID
	if req.BeforeMessageId != "" {
		id, err := uuid.Parse(req.BeforeMessageId)
		if err == nil {
			beforeID = &id
		}
	}

	msgs, err := h.FetchMessagesDirect(ctx, req.ConversationId, req.Bucket, int(req.Limit), beforeID)
	if err != nil {
		return nil, err
	}

	var pbMsgs []*chatv1.StoredMessageResponse
	for _, m := range msgs {
		pbMsgs = append(pbMsgs, &chatv1.StoredMessageResponse{
			ConversationId:   m.ConversationID,
			MessageId:        m.MessageID.String(),
			SequenceNum:      m.SequenceNum,
			SenderId:         m.SenderID,
			ClientMsgId:      m.ClientMsgID,
			EncryptedPayload: m.EncryptedPayload,
			SenderRatchetKey: m.SenderRatchetKey,
			MessageIndex:     uint32(m.MessageIndex),
			CreatedAt:        timestamppb.New(m.CreatedAt),
		})
	}

	return &chatv1.FetchMessagesResponse{Messages: pbMsgs}, nil
}

func (h *LedgerHandler) FetchMessagesDirect(ctx context.Context, conversationID string, bucket string, limit int, beforeMessageID *uuid.UUID) ([]*store.StoredMessage, error) {
	msgs, err := h.store.FetchMessages(ctx, conversationID, bucket, limit, beforeMessageID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to fetch messages: %v", err)
	}
	return msgs, nil
}

func (h *LedgerHandler) UpdateReceipt(ctx context.Context, req *chatv1.UpdateReceiptRequest) (*chatv1.UpdateReceiptResponse, error) {
	msgID, err := uuid.Parse(req.MessageId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid message_id: %v", err)
	}

	if err := h.UpdateReceiptDirect(ctx, req.ConversationId, req.UserId, req.ReceiptType, msgID, req.SequenceNum); err != nil {
		return nil, err
	}

	return &chatv1.UpdateReceiptResponse{Success: true}, nil
}

func (h *LedgerHandler) UpdateReceiptDirect(ctx context.Context, conversationID, userID string, receiptType string, messageID uuid.UUID, seq int64) error {
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

func (h *LedgerHandler) GetReceipts(ctx context.Context, req *chatv1.GetReceiptsRequest) (*chatv1.GetReceiptsResponse, error) {
	receipts, err := h.GetReceiptsDirect(ctx, req.ConversationId)
	if err != nil {
		return nil, err
	}

	var pbReceipts []*chatv1.ReceiptItem
	for _, r := range receipts {
		pbReceipts = append(pbReceipts, &chatv1.ReceiptItem{
			UserId:             r.UserID,
			DeliveredMessageId: r.LastDeliveredID.String(),
			DeliveredSeq:       r.LastDeliveredSeq,
			ReadMessageId:      r.LastReadID.String(),
			ReadSeq:            r.LastReadSeq,
			UpdatedAt:          timestamppb.New(r.UpdatedAt),
		})
	}

	return &chatv1.GetReceiptsResponse{Receipts: pbReceipts}, nil
}

func (h *LedgerHandler) GetReceiptsDirect(ctx context.Context, conversationID string) ([]*store.Receipt, error) {
	receipts, err := h.store.GetReceipts(ctx, conversationID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get receipts: %v", err)
	}
	return receipts, nil
}
