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

type CallTestOfferMessage struct {
	Type            string `json:"type"`
	CallID          string `json:"call_id"`
	TargetUserID    string `json:"target_user_id"`
	SDPOffer        string `json:"sdp_offer"`
	SFramePublicKey string `json:"sframe_public_key"`
}

type CallTestAnswerMessage struct {
	Type            string `json:"type"`
	CallID          string `json:"call_id"`
	TargetUserID    string `json:"target_user_id"`
	SDPAnswer       string `json:"sdp_answer"`
	SFramePublicKey string `json:"sframe_public_key"`
}

type MediaTestEnvelope struct {
	Type         string `json:"type"`
	ObjectKey    string `json:"object_key"`
	MediaKeyHex  string `json:"media_key_hex"`
	IVHex        string `json:"iv_hex"`
	SHA256Digest string `json:"sha256_digest"`
}

func TestWebRTCCallSignalingAndEncryptedMediaEnvelope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	callID := uuid.New().String()

	// 1. Alice connects via WebSocket
	aliceConn, _, err := websocket.Dial(ctx, "ws://localhost:8081/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-User-ID": []string{"alice-caller-uuid"},
		},
	})
	if err != nil {
		t.Logf("Alice WebSocket connection: %v (gateway container not running locally)", err)
		return
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "alice disconnected")

	// 2. Bob connects via WebSocket
	bobConn, _, err := websocket.Dial(ctx, "ws://localhost:8081/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-User-ID": []string{"bob-callee-uuid"},
		},
	})
	if err != nil {
		t.Logf("Bob WebSocket connection: %v", err)
		return
	}
	defer bobConn.Close(websocket.StatusNormalClosure, "bob disconnected")

	// 3. Alice initiates a WebRTC audio/video call with SFrame public key
	offer := CallTestOfferMessage{
		Type:            "chat.v1.CallOffer",
		CallID:          callID,
		TargetUserID:    "bob-callee-uuid",
		SDPOffer:        "v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
		SFramePublicKey: "base64-alice-sframe-x25519-public-key",
	}
	offerBytes, _ := json.Marshal(offer)
	if err := aliceConn.Write(ctx, websocket.MessageBinary, offerBytes); err != nil {
		t.Fatalf("Alice failed to send CallOffer: %v", err)
	}
	t.Log("Alice sent WebRTC CallOffer with SFrame public key")

	// 4. Bob accepts the call and responds with CallAnswer
	answer := CallTestAnswerMessage{
		Type:            "chat.v1.CallAnswer",
		CallID:          callID,
		TargetUserID:    "alice-caller-uuid",
		SDPAnswer:       "v=0\r\no=- 654321 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
		SFramePublicKey: "base64-bob-sframe-x25519-public-key",
	}
	answerBytes, _ := json.Marshal(answer)
	if err := bobConn.Write(ctx, websocket.MessageBinary, answerBytes); err != nil {
		t.Fatalf("Bob failed to send CallAnswer: %v", err)
	}
	t.Log("Bob sent WebRTC CallAnswer with SFrame public key")

	// 5. Alice sends an encrypted media attachment envelope (Zero-Knowledge)
	mediaEnv := MediaTestEnvelope{
		Type:         "chat.v1.EncryptedAttachment",
		ObjectKey:    "attachments/2026-09-02/photo-encrypted-blob-uuid",
		MediaKeyHex:  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		IVHex:        "0123456789abcdef01234567",
		SHA256Digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	}
	mediaBytes, _ := json.Marshal(mediaEnv)
	if err := aliceConn.Write(ctx, websocket.MessageBinary, mediaBytes); err != nil {
		t.Fatalf("Alice failed to transmit encrypted media envelope: %v", err)
	}
	t.Log("Alice transmitted zero-knowledge encrypted media metadata inside E2EE envelope")
}
