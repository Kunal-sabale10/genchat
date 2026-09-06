package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

// Inbound frame sent by client to Gateway for WebRTC signaling
type callSignalInbound struct {
	Action       string                 `json:"action"`
	TargetUserID string                 `json:"target_user_id"`
	SignalType   string                 `json:"signal_type"`
	CallID       string                 `json:"call_id"`
	CallType     string                 `json:"call_type,omitempty"`
	SDP          string                 `json:"sdp,omitempty"`
	Candidate    map[string]interface{} `json:"candidate,omitempty"`
}

// Outbound push frame relayed by Gateway to recipient
type callSignalPush struct {
	Type         string                 `json:"type"`
	SignalType   string                 `json:"signal_type"`
	CallID       string                 `json:"call_id"`
	SenderID     string                 `json:"sender_id"`
	TargetUserID string                 `json:"target_user_id"`
	CallType     string                 `json:"call_type,omitempty"`
	SDP          string                 `json:"sdp,omitempty"`
	Candidate    map[string]interface{} `json:"candidate,omitempty"`
}

// TestWebRTCCallSignalingFullCycle exercises the real authenticated Gateway WebSocket
// wire protocol for 1:1 calling:
// 1. Validates JWT auth via fail-closed query parameter.
// 2. Transmits WebRTC SDP offer from Alice to Bob.
// 3. Asserts Bob receives relayed offer with verified sender identity.
// 4. Transmits SDP answer from Bob to Alice.
// 5. Asserts Alice receives relayed answer.
// 6. Relays ICE candidate from Alice to Bob.
// 7. Relays hangup signal and terminates call.
func TestWebRTCCallSignalingFullCycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	aliceID := fmt.Sprintf("alice-call-%d", time.Now().UnixNano())
	bobID := fmt.Sprintf("bob-call-%d", time.Now().UnixNano())
	callID := uuid.New().String()

	aliceToken := signTestJWT(aliceID, "device-alice")
	bobToken := signTestJWT(bobID, "device-bob")

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

	// --- Step 1: Alice initiates call (offer) to Bob ---
	offerSDP := "v=0\r\no=alice 123456 2 IN IP4 127.0.0.1\r\ns=GenChat Call\r\n"
	offerMsg := callSignalInbound{
		Action:       "call_signal",
		TargetUserID: bobID,
		SignalType:   "offer",
		CallID:       callID,
		CallType:     "video",
		SDP:          offerSDP,
	}
	offerBytes, _ := json.Marshal(offerMsg)
	if err := aliceConn.Write(ctx, websocket.MessageText, offerBytes); err != nil {
		t.Fatalf("Alice failed to send offer: %v", err)
	}

	// --- Step 2: Bob receives offer from Alice ---
	_, bobRaw, err := bobConn.Read(ctx)
	if err != nil {
		t.Fatalf("Bob failed to read offer from socket: %v", err)
	}
	var bobOffer callSignalPush
	if err := json.Unmarshal(bobRaw, &bobOffer); err != nil {
		t.Fatalf("Bob failed to unmarshal offer: %v", err)
	}
	if bobOffer.Type != "call_signal" || bobOffer.SignalType != "offer" {
		t.Fatalf("Expected call_signal offer, got: %+v", bobOffer)
	}
	if bobOffer.SenderID != aliceID {
		t.Fatalf("Expected sender %s, got %s", aliceID, bobOffer.SenderID)
	}
	if bobOffer.CallID != callID || bobOffer.CallType != "video" || bobOffer.SDP != offerSDP {
		t.Fatalf("Offer payload mismatch: %+v", bobOffer)
	}
	t.Log("Bob received validated WebRTC offer from Alice")

	// --- Step 3: Bob accepts call (answer) to Alice ---
	answerSDP := "v=0\r\no=bob 654321 2 IN IP4 127.0.0.1\r\ns=GenChat Answer\r\n"
	answerMsg := callSignalInbound{
		Action:       "call_signal",
		TargetUserID: aliceID,
		SignalType:   "answer",
		CallID:       callID,
		CallType:     "video",
		SDP:          answerSDP,
	}
	answerBytes, _ := json.Marshal(answerMsg)
	if err := bobConn.Write(ctx, websocket.MessageText, answerBytes); err != nil {
		t.Fatalf("Bob failed to send answer: %v", err)
	}

	// --- Step 4: Alice receives answer from Bob ---
	_, aliceRaw, err := aliceConn.Read(ctx)
	if err != nil {
		t.Fatalf("Alice failed to read answer from socket: %v", err)
	}
	var aliceAnswer callSignalPush
	if err := json.Unmarshal(aliceRaw, &aliceAnswer); err != nil {
		t.Fatalf("Alice failed to unmarshal answer: %v", err)
	}
	if aliceAnswer.Type != "call_signal" || aliceAnswer.SignalType != "answer" {
		t.Fatalf("Expected call_signal answer, got: %+v", aliceAnswer)
	}
	if aliceAnswer.SenderID != bobID || aliceAnswer.CallID != callID || aliceAnswer.SDP != answerSDP {
		t.Fatalf("Answer payload mismatch: %+v", aliceAnswer)
	}
	t.Log("Alice received validated WebRTC answer from Bob")

	// --- Step 5: Alice exchanges ICE candidate with Bob ---
	candidateData := map[string]interface{}{
		"candidate":     "candidate:1 1 UDP 2122260223 127.0.0.1 5000 typ host",
		"sdpMid":        "0",
		"sdpMLineIndex": float64(0),
	}
	candMsg := callSignalInbound{
		Action:       "call_signal",
		TargetUserID: bobID,
		SignalType:   "ice_candidate",
		CallID:       callID,
		Candidate:    candidateData,
	}
	candBytes, _ := json.Marshal(candMsg)
	if err := aliceConn.Write(ctx, websocket.MessageText, candBytes); err != nil {
		t.Fatalf("Alice failed to send ICE candidate: %v", err)
	}

	_, bobCandRaw, err := bobConn.Read(ctx)
	if err != nil {
		t.Fatalf("Bob failed to read ICE candidate: %v", err)
	}
	var bobCandidate callSignalPush
	if err := json.Unmarshal(bobCandRaw, &bobCandidate); err != nil {
		t.Fatalf("Bob failed to unmarshal ICE candidate: %v", err)
	}
	if bobCandidate.SignalType != "ice_candidate" || bobCandidate.Candidate["candidate"] != candidateData["candidate"] {
		t.Fatalf("ICE candidate mismatch: %+v", bobCandidate)
	}
	t.Log("Bob received validated ICE candidate from Alice")

	// --- Step 6: Bob hangs up call ---
	hangupMsg := callSignalInbound{
		Action:       "call_signal",
		TargetUserID: aliceID,
		SignalType:   "hangup",
		CallID:       callID,
	}
	hangupBytes, _ := json.Marshal(hangupMsg)
	if err := bobConn.Write(ctx, websocket.MessageText, hangupBytes); err != nil {
		t.Fatalf("Bob failed to send hangup: %v", err)
	}

	_, aliceHangupRaw, err := aliceConn.Read(ctx)
	if err != nil {
		t.Fatalf("Alice failed to read hangup: %v", err)
	}
	var aliceHangup callSignalPush
	if err := json.Unmarshal(aliceHangupRaw, &aliceHangup); err != nil {
		t.Fatalf("Alice failed to unmarshal hangup: %v", err)
	}
	if aliceHangup.SignalType != "hangup" || aliceHangup.SenderID != bobID {
		t.Fatalf("Expected hangup from %s, got: %+v", bobID, aliceHangup)
	}
	t.Log("Alice received validated hangup from Bob. Full signaling cycle verified!")
}

// TestWebRTCCallPeerOffline verifies that when an offer is sent to an offline target,
// the Gateway immediately returns a peer_offline notice rather than hanging.
func TestWebRTCCallPeerOffline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	aliceID := fmt.Sprintf("alice-offline-test-%d", time.Now().UnixNano())
	callID := uuid.New().String()
	offlineTarget := "non-existent-user-uuid"

	aliceToken := signTestJWT(aliceID, "device-alice")
	aliceURL := "ws://localhost:8081/ws?token=" + url.QueryEscape(aliceToken)

	aliceConn, _, err := websocket.Dial(ctx, aliceURL, nil)
	if err != nil {
		t.Fatalf("Alice failed to connect to Gateway: %v", err)
	}
	defer aliceConn.Close(websocket.StatusNormalClosure, "alice disconnected")

	offerMsg := callSignalInbound{
		Action:       "call_signal",
		TargetUserID: offlineTarget,
		SignalType:   "offer",
		CallID:       callID,
		CallType:     "audio",
		SDP:          "v=0\r\no=alice ...",
	}
	offerBytes, _ := json.Marshal(offerMsg)
	if err := aliceConn.Write(ctx, websocket.MessageText, offerBytes); err != nil {
		t.Fatalf("Alice failed to send offer: %v", err)
	}

	_, raw, err := aliceConn.Read(ctx)
	if err != nil {
		t.Fatalf("Alice failed to read response: %v", err)
	}
	var resp callSignalPush
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}
	if resp.Type != "call_signal" || resp.SignalType != "peer_offline" {
		t.Fatalf("Expected peer_offline, got: %+v", resp)
	}
	if resp.CallID != callID {
		t.Fatalf("Expected call_id %s, got %s", callID, resp.CallID)
	}
	t.Log("Gateway returned peer_offline notice immediately for unreachable user")
}
