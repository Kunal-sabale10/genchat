package sequence

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Generator provides monotonically increasing sequence numbers per conversation.
// Uses Redis INCR for atomic, monotonic incrementing.
type Generator struct {
	client *redis.Client
}

// NewGenerator creates a new sequence generator.
func NewGenerator(client *redis.Client) *Generator {
	return &Generator{client: client}
}

// Next returns the next sequence number for a conversation.
func (g *Generator) Next(ctx context.Context, conversationID string) (int64, error) {
	key := fmt.Sprintf("seq:%s", conversationID)
	result, err := g.client.Incr(ctx, key).Result()
	if err != nil {
		return 0, fmt.Errorf("sequence generation failed for %s: %w", conversationID, err)
	}
	return result, nil
}

// Current returns the current sequence number without incrementing.
func (g *Generator) Current(ctx context.Context, conversationID string) (int64, error) {
	key := fmt.Sprintf("seq:%s", conversationID)
	result, err := g.client.Get(ctx, key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("sequence fetch failed for %s: %w", conversationID, err)
	}
	return result, nil
}
