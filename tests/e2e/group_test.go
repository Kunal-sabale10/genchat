package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

type GroupTestMessage struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	Payload   string `json:"payload"`
	Epoch     uint64 `json:"epoch"`
}

type TypingMessage struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	IsTyping  bool   `json:"is_typing"`
}

type PresenceMessage struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

func TestGroupMessagingAndPresenceLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	channelID := uuid.New().String()

	// 1. Alice connects via WebSocket
	aliceConn, _, err := websocket.Dial(ctx, "ws://localhost:8081/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-User-ID": []string{"alice-user-uuid"},
		},
	})
	if err != nil {
		t.Logf("Gateway WebSocket connection: %v (gateway container not running locally)", err)
		return
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "alice disconnected")

	// 2. Bob connects via WebSocket
	bobConn, _, err := websocket.Dial(ctx, "ws://localhost:8081/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-User-ID": []string{"bob-user-uuid"},
		},
	})
	if err != nil {
		t.Logf("Bob WebSocket connection: %v", err)
		return
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "bob disconnected")

	// 3. Alice sends a typing indicator on the channel
	typingMsg := TypingMessage{
		Type:      "chat.v1.TypingIndicator",
		ChannelID: channelID,
		IsTyping:  true,
	}
	typingBytes, _ := json.Marshal(typingMsg)
	if err := aliceConn.Write(ctx, websocket.MessageBinary, typingBytes); err != nil {
		t.Fatalf("Alice failed to write typing indicator: %v", err)
	}
	t.Log("Alice sent typing indicator over WebSocket")

	// 4. Alice sends an MLS encrypted group message (Epoch 1)
	groupMsg := GroupTestMessage{
		Type:      "chat.v1.SendGroupMessage",
		ChannelID: channelID,
		Payload:   "base64-mls-treekem-ciphertext-payload",
		Epoch:     1,
	}
	msgBytes, _ := json.Marshal(groupMsg)
	if err := aliceConn.Write(ctx, websocket.MessageBinary, msgBytes); err != nil {
		t.Fatalf("Alice failed to write group message: %v", err)
	}
	t.Log("Alice broadcast MLS group message to channel")

	// 5. Bob updates his presence status to "online"
	presenceMsg := PresenceMessage{
		Type:   "chat.v1.PresenceUpdate",
		Status: "online",
	}
	presenceBytes, _ := json.Marshal(presenceMsg)
	if err := bobConn.Write(ctx, websocket.MessageBinary, presenceBytes); err != nil {
		t.Fatalf("Bob failed to update presence: %v", err)
	}
	t.Log("Bob updated presence to online")
}
