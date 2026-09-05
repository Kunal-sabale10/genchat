package e2e

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// testJWTSecret must match the JWT_SECRET the gateway/auth services are
// started with for these tests (see deploy/docker-compose.yaml).
const testJWTSecret = "dev-secret-change-in-production"

// signTestJWT builds an HS256 token in the same format services/auth's
// generateJWT produces, so these tests exercise the real (fail-closed)
// verification path in ws/handler.go rather than a bypass.
func signTestJWT(userID, deviceID string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		`{"sub":"%s","device_id":"%s","exp":%d}`, userID, deviceID, time.Now().Add(time.Hour).Unix())))
	sigBase := header + "." + payload
	mac := hmac.New(sha256.New, []byte(testJWTSecret))
	mac.Write([]byte(sigBase))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return sigBase + "." + sig
}

type ackFrame struct {
	Type        string `json:"type"`
	ClientMsgID string `json:"client_msg_id"`
	MessageID   string `json:"message_id"`
	SequenceNum int64  `json:"sequence_num"`
}

type pushFrame struct {
	Type          string `json:"type"`
	ChannelID     string `json:"channel_id"`
	SenderID      string `json:"sender_id"`
	CiphertextB64 string `json:"ciphertext_base64"`
	MessageID     string `json:"server_id"`
}

// TestAliceToBobWebSocketDelivery exercises the full send path: real JWT
// auth (the gateway now rejects unauthenticated/malformed tokens), ledgerd
// persistence (the gateway ACKs only after StoreMessage succeeds), and
// live delivery to Bob's socket. This replaces the earlier version of this
// test, which connected via the (now-removed) X-User-ID bypass and never
// read from Bob's connection or asserted anything was actually delivered.
func TestAliceToBobWebSocketDelivery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	aliceToken := signTestJWT("alice-user-1", "alice-device-1")
	bobToken := signTestJWT("bob-user-1", "bob-device-1")

	aliceURL := "ws://localhost:8081/ws?token=" + url.QueryEscape(aliceToken)
	bobURL := "ws://localhost:8081/ws?token=" + url.QueryEscape(bobToken)

	aliceConn, _, err := websocket.Dial(ctx, aliceURL, nil)
	if err != nil {
		t.Fatalf("Alice failed to connect to Gateway: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "alice disconnected")

	bobConn, _, err := websocket.Dial(ctx, bobURL, nil)
	if err != nil {
		t.Fatalf("Bob failed to connect to Gateway: %v", err)
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "bob disconnected")

	clientMsgID := fmt.Sprintf("e2e-%d", time.Now().UnixNano())
	ciphertext := base64.StdEncoding.EncodeToString([]byte("pqxdh-ciphertext-envelope"))

	sendFrame, _ := json.Marshal(map[string]any{
		"action":            "send_message",
		"channel_id":        "bob-user-1", // Phase 8: channel_id IS the recipient user_id for 1:1
		"client_msg_id":     clientMsgID,
		"ciphertext_base64": ciphertext,
	})
	if err := aliceConn.Write(ctx, websocket.MessageBinary, sendFrame); err != nil {
		t.Fatalf("Alice failed to write frame: %v", err)
	}

	// Alice must receive an ACK — and per the gateway's persistence fix,
	// this only arrives after ledgerd has durably stored the message.
	_, ackBytes, err := aliceConn.Read(ctx)
	if err != nil {
		t.Fatalf("Alice did not receive an ACK: %v", err)
	}
	var ack ackFrame
	if err := json.Unmarshal(ackBytes, &ack); err != nil {
		t.Fatalf("Alice's ACK frame was not valid JSON: %v", err)
	}
	if ack.Type != "ack" || ack.ClientMsgID != clientMsgID {
		t.Fatalf("unexpected ACK: %+v", ack)
	}
	if ack.MessageID == "" {
		t.Fatalf("ACK did not include a durable message_id — message was not persisted")
	}

	// Bob must actually receive the pushed message.
	_, pushBytes, err := bobConn.Read(ctx)
	if err != nil {
		t.Fatalf("Bob did not receive the pushed message: %v", err)
	}
	var push pushFrame
	if err := json.Unmarshal(pushBytes, &push); err != nil {
		t.Fatalf("Bob's push frame was not valid JSON: %v", err)
	}
	if push.Type != "push" || push.SenderID != "alice-user-1" || push.CiphertextB64 != ciphertext {
		t.Fatalf("unexpected push frame delivered to Bob: %+v", push)
	}
}

// TestUnauthenticatedConnectionRejected asserts the fail-closed auth fix:
// connecting without a valid JWT must be refused, not silently accepted
// under a raw-token identity.
func TestUnauthenticatedConnectionRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, "ws://localhost:8081/ws", nil)
	if err == nil {
		t.Fatalf("expected connection without a token to be rejected, but it succeeded")
	}
	if resp != nil && resp.StatusCode != 401 {
		t.Fatalf("expected 401 Unauthorized, got %d", resp.StatusCode)
	}
}
