package pubsub

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type PresenceInfo struct {
	UserID       string    `json:"user_id"`
	Status       string    `json:"status"` // "online", "away", "offline"
	CustomStatus string    `json:"custom_status,omitempty"`
	LastSeen     time.Time `json:"last_seen"`
}

type TypingEvent struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	IsTyping  bool   `json:"is_typing"`
}

type RedisPubSub struct {
	client *redis.Client
}

func NewRedisPubSub(redisAddr string, password string) *RedisPubSub {
	rdb := redis.NewClient(&redis.Options{
		Addr:     redisAddr,
		Password: password,
		DB:       0,
	})
	return &RedisPubSub{client: rdb}
}

func (r *RedisPubSub) Close() error {
	return r.client.Close()
}

// -------------------------------------------------------------
// Channel Fan-Out Pub/Sub
// -------------------------------------------------------------

func (r *RedisPubSub) PublishChannelMessage(ctx context.Context, channelID string, payload []byte) error {
	topic := fmt.Sprintf("channel:%s", channelID)
	return r.client.Publish(ctx, topic, payload).Err()
}

func (r *RedisPubSub) SubscribeChannel(ctx context.Context, channelID string) *redis.PubSub {
	topic := fmt.Sprintf("channel:%s", channelID)
	return r.client.Subscribe(ctx, topic)
}

// -------------------------------------------------------------
// Ephemeral Typing Indicators (5s TTL)
// -------------------------------------------------------------

func (r *RedisPubSub) PublishTyping(ctx context.Context, channelID, userID string, isTyping bool) error {
	event := TypingEvent{
		ChannelID: channelID,
		UserID:    userID,
		IsTyping:  isTyping,
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("typing:%s:%s", channelID, userID)
	if isTyping {
		r.client.Set(ctx, key, "1", 5*time.Second)
	} else {
		r.client.Del(ctx, key)
	}

	topic := fmt.Sprintf("typing:%s", channelID)
	return r.client.Publish(ctx, topic, data).Err()
}

func (r *RedisPubSub) SubscribeTyping(ctx context.Context, channelID string) *redis.PubSub {
	topic := fmt.Sprintf("typing:%s", channelID)
	return r.client.Subscribe(ctx, topic)
}

// -------------------------------------------------------------
// Real-Time Presence & Heartbeats
// -------------------------------------------------------------

func (r *RedisPubSub) SetPresence(ctx context.Context, userID, status, customStatus string, ttl time.Duration) error {
	info := PresenceInfo{
		UserID:       userID,
		Status:       status,
		CustomStatus: customStatus,
		LastSeen:     time.Now().UTC(),
	}
	data, err := json.Marshal(info)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("presence:%s", userID)
	if err := r.client.Set(ctx, key, data, ttl).Err(); err != nil {
		return err
	}

	// Broadcast presence change event
	return r.client.Publish(ctx, "presence:events", data).Err()
}

func (r *RedisPubSub) GetPresence(ctx context.Context, userIDs []string) (map[string]PresenceInfo, error) {
	result := make(map[string]PresenceInfo)
	if len(userIDs) == 0 {
		return result, nil
	}

	keys := make([]string, len(userIDs))
	for i, id := range userIDs {
		keys[i] = fmt.Sprintf("presence:%s", id)
	}

	vals, err := r.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}

	for i, val := range vals {
		if str, ok := val.(string); ok && str != "" {
			var p PresenceInfo
			if err := json.Unmarshal([]byte(str), &p); err == nil {
				result[userIDs[i]] = p
				continue
			}
		}
		// Default offline
		result[userIDs[i]] = PresenceInfo{
			UserID:   userIDs[i],
			Status:   "offline",
			LastSeen: time.Time{},
		}
	}

	return result, nil
}

func (r *RedisPubSub) Heartbeat(ctx context.Context, userID string) error {
	key := fmt.Sprintf("presence:%s", userID)
	return r.client.Expire(ctx, key, 60*time.Second).Err()
}
