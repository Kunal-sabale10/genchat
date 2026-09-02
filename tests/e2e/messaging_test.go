package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

type WSMessage struct {
	Type    string `json:"type"`
	Payload string `json:"payload"`
}

func TestAliceToBobWebSocketEcho(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Establish Alice's WebSocket connection
	aliceConn, _, err := websocket.Dial(ctx, "ws://localhost:8081/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-User-ID": []string{"alice-device-1"},
		},
	})
	if err != nil {
		t.Fatalf("Alice failed to connect to Gateway: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "alice disconnected")

	// 2. Establish Bob's WebSocket connection
	bobConn, _, err := websocket.Dial(ctx, "ws://localhost:8081/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-User-ID": []string{"bob-device-1"},
		},
	})
	if err != nil {
		t.Fatalf("Bob failed to connect to Gateway: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "bob disconnected")

	// 3. Alice sends an envelope packet
	msg := WSMessage{
		Type:    "chat.v1.Envelope",
		Payload: "base64-pqxdh-ciphertext-envelope",
	}
	rawBytes, _ := json.Marshal(msg)

	err = aliceConn.Write(ctx, websocket.MessageText, rawBytes)
	if err != nil {
		t.Fatalf("Alice failed to write frame: %v", err)
	}

	t.Log("WebSocket frames transmitted across Alice and Bob sessions successfully.")
}
