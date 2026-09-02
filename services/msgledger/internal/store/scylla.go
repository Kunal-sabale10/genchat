package store

import (
	"context"
	"time"

	"github.com/gocql/gocql"
	"github.com/google/uuid"
)

type ScyllaStore struct {
	session *gocql.Session
}

func NewScyllaStore(session *gocql.Session) *ScyllaStore {
	return &ScyllaStore{session: session}
}

type Message struct {
	ConversationID   string
	SenderID         string
	ClientMsgID      string
	EncryptedPayload []byte
	SenderRatchetKey []byte
	MessageIndex     int
}

type StoredMessage struct {
	ConversationID   string
	Bucket           string
	MessageID        uuid.UUID
	SequenceNum      int64
	SenderID         string
	ClientMsgID      string
	EncryptedPayload []byte
	SenderRatchetKey []byte
	MessageIndex     int
	CreatedAt        time.Time
}

type Receipt struct {
	ConversationID   string
	UserID           string
	LastDeliveredID  uuid.UUID
	LastDeliveredSeq int64
	LastReadID       uuid.UUID
	LastReadSeq      int64
	UpdatedAt        time.Time
}

func (s *ScyllaStore) InsertMessage(ctx context.Context, msg *StoredMessage) error {
	msgID, err := gocql.ParseUUID(msg.MessageID.String())
	if err != nil {
		return err
	}
	return s.session.Query(
		`INSERT INTO genchat.messages 
		(conversation_id, bucket, message_id, sequence_num, sender_id, client_msg_id, 
		 encrypted_payload, sender_ratchet_key, message_index, created_at) 
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ConversationID, msg.Bucket, msgID, msg.SequenceNum,
		msg.SenderID, msg.ClientMsgID, msg.EncryptedPayload, msg.SenderRatchetKey,
		msg.MessageIndex, msg.CreatedAt,
	).WithContext(ctx).Exec()
}

func (s *ScyllaStore) CheckDedup(ctx context.Context, conversationID, clientMsgID string) (bool, error) {
	var count int
	err := s.session.Query(
		`SELECT count(*) FROM genchat.client_dedup WHERE conversation_id = ? AND client_msg_id = ? LIMIT 1`,
		conversationID, clientMsgID,
	).WithContext(ctx).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (s *ScyllaStore) InsertDedup(ctx context.Context, conversationID, clientMsgID string, messageID gocql.UUID) error {
	return s.session.Query(
		`INSERT INTO genchat.client_dedup (conversation_id, client_msg_id, message_id, created_at) VALUES (?, ?, ?, ?)`,
		conversationID, clientMsgID, messageID, time.Now(),
	).WithContext(ctx).Exec()
}

func (s *ScyllaStore) FetchMessages(ctx context.Context, conversationID, bucket string, limit int, beforeID *uuid.UUID) ([]*StoredMessage, error) {
	var query string
	var args []interface{}

	if beforeID != nil {
		gocqlBeforeID, err := gocql.ParseUUID(beforeID.String())
		if err != nil {
			return nil, err
		}
		query = `SELECT message_id, sequence_num, sender_id, client_msg_id, encrypted_payload, 
			sender_ratchet_key, message_index, created_at 
			FROM genchat.messages 
			WHERE conversation_id = ? AND bucket = ? AND message_id < ? 
			LIMIT ?`
		args = []interface{}{conversationID, bucket, gocqlBeforeID, limit}
	} else {
		query = `SELECT message_id, sequence_num, sender_id, client_msg_id, encrypted_payload, 
			sender_ratchet_key, message_index, created_at 
			FROM genchat.messages 
			WHERE conversation_id = ? AND bucket = ? 
			LIMIT ?`
		args = []interface{}{conversationID, bucket, limit}
	}

	iter := s.session.Query(query, args...).WithContext(ctx).Iter()
	var messages []*StoredMessage
	
	var msgID gocql.UUID
	var seqNum int64
	var senderID string
	var clientMsgID string
	var encPayload []byte
	var senderRatchKey []byte
	var msgIndex int
	var createdAt time.Time
	
	for iter.Scan(&msgID, &seqNum, &senderID, &clientMsgID, &encPayload, &senderRatchKey, &msgIndex, &createdAt) {
		parsedMsgID, _ := uuid.Parse(msgID.String())
		messages = append(messages, &StoredMessage{
			ConversationID:   conversationID,
			Bucket:           bucket,
			MessageID:        parsedMsgID,
			SequenceNum:      seqNum,
			SenderID:         senderID,
			ClientMsgID:      clientMsgID,
			EncryptedPayload: encPayload,
			SenderRatchetKey: senderRatchKey,
			MessageIndex:     msgIndex,
			CreatedAt:        createdAt,
		})
	}
	
	return messages, iter.Close()
}

func (s *ScyllaStore) UpsertReceipt(ctx context.Context, conversationID, userID string, deliveredID, readID *uuid.UUID, deliveredSeq, readSeq int64) error {
	var q string
	var err error
	var gocqlDeliveredID, gocqlReadID gocql.UUID
	
	if deliveredID != nil {
		gocqlDeliveredID, err = gocql.ParseUUID(deliveredID.String())
		if err != nil { return err }
		q = `UPDATE genchat.receipts SET last_delivered_id = ?, last_delivered_seq = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`
		return s.session.Query(q, gocqlDeliveredID, deliveredSeq, time.Now(), conversationID, userID).WithContext(ctx).Exec()
	}
	
	if readID != nil {
		gocqlReadID, err = gocql.ParseUUID(readID.String())
		if err != nil { return err }
		q = `UPDATE genchat.receipts SET last_read_id = ?, last_read_seq = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`
		return s.session.Query(q, gocqlReadID, readSeq, time.Now(), conversationID, userID).WithContext(ctx).Exec()
	}
	
	return nil
}

func (s *ScyllaStore) GetReceipts(ctx context.Context, conversationID string) ([]*Receipt, error) {
	iter := s.session.Query(`SELECT user_id, last_delivered_id, last_delivered_seq, last_read_id, last_read_seq, updated_at FROM genchat.receipts WHERE conversation_id = ?`, conversationID).WithContext(ctx).Iter()
	
	var receipts []*Receipt
	var userID string
	var delID, readID gocql.UUID
	var delSeq, readSeq int64
	var updatedAt time.Time
	
	for iter.Scan(&userID, &delID, &delSeq, &readID, &readSeq, &updatedAt) {
		parsedDelID, _ := uuid.Parse(delID.String())
		parsedReadID, _ := uuid.Parse(readID.String())
		receipts = append(receipts, &Receipt{
			ConversationID:   conversationID,
			UserID:           userID,
			LastDeliveredID:  parsedDelID,
			LastDeliveredSeq: delSeq,
			LastReadID:       parsedReadID,
			LastReadSeq:      readSeq,
			UpdatedAt:        updatedAt,
		})
	}
	return receipts, iter.Close()
}
