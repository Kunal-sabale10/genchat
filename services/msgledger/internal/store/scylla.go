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
	EphemeralTTLSec  int64
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
	Deduplicated     bool
	EphemeralTTLSec  int64
}

type DedupRecord struct {
	MessageID   uuid.UUID
	SequenceNum int64
	CreatedAt   time.Time
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
	if msg.ClientMsgID != "" {
		_ = s.RecordAuthor(ctx, msg.ConversationID, msg.ClientMsgID, msg.SenderID)
	}
	_ = s.RecordAuthor(ctx, msg.ConversationID, msg.MessageID.String(), msg.SenderID)

	if msg.EphemeralTTLSec > 0 {
		return s.session.Query(
			`INSERT INTO genchat.messages 
			(conversation_id, bucket, message_id, sequence_num, sender_id, client_msg_id, 
			 encrypted_payload, sender_ratchet_key, message_index, created_at) 
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?`,
			msg.ConversationID, msg.Bucket, msgID, msg.SequenceNum,
			msg.SenderID, msg.ClientMsgID, msg.EncryptedPayload, msg.SenderRatchetKey,
			msg.MessageIndex, msg.CreatedAt, msg.EphemeralTTLSec,
		).WithContext(ctx).Exec()
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

func (s *ScyllaStore) GetDedup(ctx context.Context, conversationID, clientMsgID string) (*DedupRecord, error) {
	var msgID gocql.UUID
	var seqNum int64
	var createdAt time.Time
	err := s.session.Query(
		`SELECT message_id, sequence_num, created_at FROM genchat.client_dedup WHERE conversation_id = ? AND client_msg_id = ? LIMIT 1`,
		conversationID, clientMsgID,
	).WithContext(ctx).Scan(&msgID, &seqNum, &createdAt)
	if err != nil {
		if err == gocql.ErrNotFound {
			return nil, nil
		}
		// Fallback for legacy tables where sequence_num was not yet present
		errScan := s.session.Query(
			`SELECT message_id, created_at FROM genchat.client_dedup WHERE conversation_id = ? AND client_msg_id = ? LIMIT 1`,
			conversationID, clientMsgID,
		).WithContext(ctx).Scan(&msgID, &createdAt)
		if errScan != nil {
			if errScan == gocql.ErrNotFound {
				return nil, nil
			}
			return nil, err
		}
	}
	parsedID, err := uuid.Parse(msgID.String())
	if err != nil {
		return nil, err
	}
	return &DedupRecord{
		MessageID:   parsedID,
		SequenceNum: seqNum,
		CreatedAt:   createdAt,
	}, nil
}

func (s *ScyllaStore) CheckDedup(ctx context.Context, conversationID, clientMsgID string) (bool, error) {
	rec, err := s.GetDedup(ctx, conversationID, clientMsgID)
	if err != nil {
		return false, err
	}
	return rec != nil, nil
}

func (s *ScyllaStore) InsertDedup(ctx context.Context, conversationID, clientMsgID string, messageID gocql.UUID, sequenceNum int64, ttlSec int64) error {
	if ttlSec > 0 {
		return s.session.Query(
			`INSERT INTO genchat.client_dedup (conversation_id, client_msg_id, message_id, sequence_num, created_at) VALUES (?, ?, ?, ?, ?) USING TTL ?`,
			conversationID, clientMsgID, messageID, sequenceNum, time.Now(), ttlSec,
		).WithContext(ctx).Exec()
	}
	return s.session.Query(
		`INSERT INTO genchat.client_dedup (conversation_id, client_msg_id, message_id, sequence_num, created_at) VALUES (?, ?, ?, ?, ?)`,
		conversationID, clientMsgID, messageID, sequenceNum, time.Now(),
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
			sender_ratchet_key, message_index, created_at, TTL(encrypted_payload) 
			FROM genchat.messages 
			WHERE conversation_id = ? AND bucket = ? AND message_id < ? 
			LIMIT ?`
		args = []interface{}{conversationID, bucket, gocqlBeforeID, limit}
	} else {
		query = `SELECT message_id, sequence_num, sender_id, client_msg_id, encrypted_payload, 
			sender_ratchet_key, message_index, created_at, TTL(encrypted_payload) 
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
	var ttlSec *int
	
	for iter.Scan(&msgID, &seqNum, &senderID, &clientMsgID, &encPayload, &senderRatchKey, &msgIndex, &createdAt, &ttlSec) {
		parsedMsgID, _ := uuid.Parse(msgID.String())
		var ephemeralTTL int64
		if ttlSec != nil && *ttlSec > 0 {
			ephemeralTTL = int64(*ttlSec)
		}
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
			EphemeralTTLSec:  ephemeralTTL,
		})
		ttlSec = nil
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
		q = `UPDATE genchat.message_receipts SET last_delivered_id = ?, last_delivered_seq = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`
		return s.session.Query(q, gocqlDeliveredID, deliveredSeq, time.Now(), conversationID, userID).WithContext(ctx).Exec()
	}
	
	if readID != nil {
		gocqlReadID, err = gocql.ParseUUID(readID.String())
		if err != nil { return err }
		q = `UPDATE genchat.message_receipts SET last_read_id = ?, last_read_seq = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`
		return s.session.Query(q, gocqlReadID, readSeq, time.Now(), conversationID, userID).WithContext(ctx).Exec()
	}
	
	return nil
}

func (s *ScyllaStore) GetReceipts(ctx context.Context, conversationID string) ([]*Receipt, error) {
	iter := s.session.Query(`SELECT user_id, last_delivered_id, last_delivered_seq, last_read_id, last_read_seq, updated_at FROM genchat.message_receipts WHERE conversation_id = ?`, conversationID).WithContext(ctx).Iter()
	
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

type MessageAuthor struct {
	ConversationID string
	MessageID      string
	SenderID       string
	CreatedAt      time.Time
}

type MessageEvent struct {
	ConversationID string
	MessageID      string
	EventType      string
	ActorID        string
	NewCiphertext  []byte
	CreatedAt      time.Time
}

func (s *ScyllaStore) RecordAuthor(ctx context.Context, conversationID, messageID, senderID string) error {
	return s.session.Query(
		`INSERT INTO genchat.message_authors (conversation_id, message_id, sender_id, created_at) VALUES (?, ?, ?, ?)`,
		conversationID, messageID, senderID, time.Now(),
	).WithContext(ctx).Exec()
}

func (s *ScyllaStore) GetAuthor(ctx context.Context, conversationID, messageID string) (string, time.Time, error) {
	var senderID string
	var createdAt time.Time
	err := s.session.Query(
		`SELECT sender_id, created_at FROM genchat.message_authors WHERE conversation_id = ? AND message_id = ? LIMIT 1`,
		conversationID, messageID,
	).WithContext(ctx).Scan(&senderID, &createdAt)
	if err != nil {
		if err == gocql.ErrNotFound {
			return "", time.Time{}, nil
		}
		return "", time.Time{}, err
	}
	return senderID, createdAt, nil
}

func (s *ScyllaStore) RecordEvent(ctx context.Context, conversationID, messageID, eventType, actorID string, newCiphertext []byte) error {
	return s.session.Query(
		`INSERT INTO genchat.message_events (conversation_id, message_id, event_type, actor_id, new_ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		conversationID, messageID, eventType, actorID, newCiphertext, time.Now(),
	).WithContext(ctx).Exec()
}

func (s *ScyllaStore) FetchEvents(ctx context.Context, conversationID, messageID string) ([]*MessageEvent, error) {
	var iter *gocql.Iter
	if messageID != "" {
		iter = s.session.Query(
			`SELECT message_id, event_type, actor_id, new_ciphertext, created_at FROM genchat.message_events WHERE conversation_id = ? AND message_id = ?`,
			conversationID, messageID,
		).WithContext(ctx).Iter()
	} else {
		iter = s.session.Query(
			`SELECT message_id, event_type, actor_id, new_ciphertext, created_at FROM genchat.message_events WHERE conversation_id = ?`,
			conversationID,
		).WithContext(ctx).Iter()
	}

	var events []*MessageEvent
	var mID, eType, actor string
	var newCT []byte
	var createdAt time.Time

	for iter.Scan(&mID, &eType, &actor, &newCT, &createdAt) {
		events = append(events, &MessageEvent{
			ConversationID: conversationID,
			MessageID:      mID,
			EventType:      eType,
			ActorID:        actor,
			NewCiphertext:  newCT,
			CreatedAt:      createdAt,
		})
	}
	return events, iter.Close()
}
