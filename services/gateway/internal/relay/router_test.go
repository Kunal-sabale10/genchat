package relay

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/gateway/internal/ledgerclient"
	"github.com/genchat/services/gateway/internal/ws"
)

// mockLedgerRPC implements chatv1.LedgerServiceClient for unit testing.
type mockLedgerRPC struct {
	chatv1.LedgerServiceClient
	authors map[string]string // "conversation_id:message_id" -> author_id
	err     error
}

func (m *mockLedgerRPC) GetMessageAuthor(ctx context.Context, req *chatv1.GetMessageAuthorRequest, opts ...grpc.CallOption) (*chatv1.GetMessageAuthorResponse, error) {
	if m.err != nil {
		return nil, m.err
	}
	key := req.ConversationId + ":" + req.MessageId
	author, ok := m.authors[key]
	if !ok || author == "" {
		return &chatv1.GetMessageAuthorResponse{SenderId: ""}, nil
	}
	return &chatv1.GetMessageAuthorResponse{SenderId: author}, nil
}

func (m *mockLedgerRPC) RecordMessageEvent(ctx context.Context, req *chatv1.RecordMessageEventRequest, opts ...grpc.CallOption) (*chatv1.RecordMessageEventResponse, error) {
	if m.err != nil {
		return nil, m.err
	}
	return &chatv1.RecordMessageEventResponse{Success: true}, nil
}

func (m *mockLedgerRPC) StoreMessage(ctx context.Context, req *chatv1.StoreMessageRequest, opts ...grpc.CallOption) (*chatv1.StoreMessageResponse, error) {
	if m.err != nil {
		return nil, m.err
	}
	return &chatv1.StoreMessageResponse{}, nil
}

// mockChannelRPC implements chatv1.ChannelServiceClient for unit testing.
type mockChannelRPC struct {
	chatv1.ChannelServiceClient
	members map[string][]string // channelID -> []userID
	err     error
}

func (m *mockChannelRPC) GetChannelMembers(ctx context.Context, req *chatv1.GetChannelMembersRequest, opts ...grpc.CallOption) (*chatv1.GetChannelMembersResponse, error) {
	if m.err != nil {
		return nil, m.err
	}
	uids := m.members[req.ChannelId]
	var respMembers []*chatv1.ChannelMember
	for _, uid := range uids {
		respMembers = append(respMembers, &chatv1.ChannelMember{
			UserId: uid,
			Role:   chatv1.ChannelRole_CHANNEL_ROLE_MEMBER,
		})
	}
	return &chatv1.GetChannelMembersResponse{
		Members: respMembers,
	}, nil
}

// setupTestRouter creates a test Router with mock dependencies and an active hub.
func setupTestRouter(ledgerRPC chatv1.LedgerServiceClient, channelRPC chatv1.ChannelServiceClient) (*Router, *ws.Hub) {
	hub := ws.NewHub()
	go hub.Run()
	var lc *ledgerclient.Client
	if ledgerRPC != nil {
		lc = ledgerclient.NewTestClient(ledgerRPC)
	}
	router := NewRouter(hub, lc, nil, channelRPC, nil, nil)
	return router, hub
}

func newTestConn(hub *ws.Hub, userID, deviceID string) *ws.Conn {
	conn := &ws.Conn{
		ID:       "conn_" + userID + "_" + deviceID,
		UserID:   userID,
		DeviceID: deviceID,
		Send:     make(chan []byte, 100),
		Hub:      hub,
	}
	hub.Register(conn)
	time.Sleep(15 * time.Millisecond)
	return conn
}

func readFrames(conn *ws.Conn, maxFrames int, timeout time.Duration) []map[string]interface{} {
	var frames []map[string]interface{}
	deadline := time.After(timeout)
	for i := 0; i < maxFrames; i++ {
		select {
		case data := <-conn.Send:
			var m map[string]interface{}
			if err := json.Unmarshal(data, &m); err == nil {
				frames = append(frames, m)
			}
		case <-deadline:
			return frames
		}
	}
	return frames
}

func hasFrameType(frames []map[string]interface{}, expectedType string) bool {
	for _, f := range frames {
		if t, ok := f["type"].(string); ok && t == expectedType {
			return true
		}
	}
	return false
}

func getErrorCode(frames []map[string]interface{}) string {
	for _, f := range frames {
		if t, ok := f["type"].(string); ok && t == "error" {
			if c, ok := f["code"].(string); ok {
				return c
			}
		}
	}
	return ""
}

func TestTableDriven_DeleteMessage(t *testing.T) {
	aliceID := "usr_alice"
	bobID := "usr_bob"
	msgID := "msg_123"
	convID := getConversationID(aliceID, bobID)

	tests := []struct {
		name          string
		sender        string
		ledgerAuthors map[string]string
		ledgerErr     error
		ledgerNil     bool
		rawPayload    []byte
		expectedCode  string
		expectSuccess bool
	}{
		{
			name:   "CorrectOwner_Succeeds",
			sender: aliceID,
			ledgerAuthors: map[string]string{
				convID + ":" + msgID: aliceID,
			},
			rawPayload:    []byte(`{"action":"delete_message","channel_id":"` + bobID + `","message_id":"` + msgID + `","delete_scope":"everyone"}`),
			expectSuccess: true,
		},
		{
			name:   "Imposter_Rejected_PermissionDenied",
			sender: bobID, // Bob tries to delete Alice's message
			ledgerAuthors: map[string]string{
				convID + ":" + msgID: aliceID,
			},
			rawPayload:   []byte(`{"action":"delete_message","channel_id":"` + aliceID + `","message_id":"` + msgID + `","delete_scope":"everyone"}`),
			expectedCode: "PERMISSION_DENIED",
		},
		{
			name:          "LedgerError_FailsClosed_PermissionDenied",
			sender:        aliceID,
			ledgerErr:     errors.New("scylla connection timeout"),
			rawPayload:    []byte(`{"action":"delete_message","channel_id":"` + bobID + `","message_id":"` + msgID + `","delete_scope":"everyone"}`),
			expectedCode:  "PERMISSION_DENIED",
		},
		{
			name:          "MessageNotFound_FailsClosed_PermissionDenied",
			sender:        aliceID,
			ledgerAuthors: map[string]string{}, // empty store
			rawPayload:    []byte(`{"action":"delete_message","channel_id":"` + bobID + `","message_id":"nonexistent_msg","delete_scope":"everyone"}`),
			expectedCode:  "PERMISSION_DENIED",
		},
		{
			name:         "LedgerNil_FailsClosed_InternalError",
			sender:       aliceID,
			ledgerNil:    true,
			rawPayload:   []byte(`{"action":"delete_message","channel_id":"` + bobID + `","message_id":"` + msgID + `","delete_scope":"everyone"}`),
			expectedCode: "INTERNAL_ERROR",
		},
		{
			name:         "MissingFields_Rejected",
			sender:       aliceID,
			rawPayload:   []byte(`{"action":"delete_message"}`),
			expectedCode: "MISSING_FIELDS",
		},
		{
			name:         "MalformedJSON_Rejected",
			sender:       aliceID,
			rawPayload:   []byte(`{"action":"delete_message", invalid`),
			expectedCode: "INVALID_JSON",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mockL chatv1.LedgerServiceClient
			if !tt.ledgerNil {
				mockL = &mockLedgerRPC{
					authors: tt.ledgerAuthors,
					err:     tt.ledgerErr,
				}
			}
			router, hub := setupTestRouter(mockL, nil)
			conn := newTestConn(hub, tt.sender, "dev_1")

			err := router.Handle(context.Background(), conn, tt.rawPayload)

			if tt.expectSuccess {
				if err != nil {
					t.Fatalf("unexpected Handle error: %v", err)
				}
				frames := readFrames(conn, 5, 200*time.Millisecond)
				if !hasFrameType(frames, "ack_delete") {
					t.Fatalf("expected ack_delete frame, got: %+v", frames)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error from Handle, got nil")
				}
				if !strings.Contains(err.Error(), tt.expectedCode) {
					t.Fatalf("expected error containing %s, got: %v", tt.expectedCode, err)
				}
				frames := readFrames(conn, 5, 200*time.Millisecond)
				code := getErrorCode(frames)
				if code != tt.expectedCode {
					t.Fatalf("expected error frame code %s, got: %s (frames: %+v)", tt.expectedCode, code, frames)
				}
			}
		})
	}
}

func TestTableDriven_EditMessage(t *testing.T) {
	aliceID := "usr_alice"
	bobID := "usr_bob"
	msgID := "msg_edit_1"
	convID := getConversationID(aliceID, bobID)

	tests := []struct {
		name          string
		sender        string
		ledgerAuthors map[string]string
		ledgerErr     error
		rawPayload    []byte
		expectedCode  string
		expectSuccess bool
	}{
		{
			name:   "CorrectOwner_Succeeds",
			sender: aliceID,
			ledgerAuthors: map[string]string{
				convID + ":" + msgID: aliceID,
			},
			rawPayload:    []byte(`{"action":"edit_message","channel_id":"` + bobID + `","message_id":"` + msgID + `","ciphertext_base64":"bmV3VGV4dA=="}`),
			expectSuccess: true,
		},
		{
			name:   "Imposter_Rejected_PermissionDenied",
			sender: bobID,
			ledgerAuthors: map[string]string{
				convID + ":" + msgID: aliceID,
			},
			rawPayload:   []byte(`{"action":"edit_message","channel_id":"` + aliceID + `","message_id":"` + msgID + `","ciphertext_base64":"bmV3VGV4dA=="}`),
			expectedCode: "PERMISSION_DENIED",
		},
		{
			name:         "LedgerError_FailsClosed_PermissionDenied",
			sender:       aliceID,
			ledgerErr:    errors.New("db timeout"),
			rawPayload:   []byte(`{"action":"edit_message","channel_id":"` + bobID + `","message_id":"` + msgID + `","ciphertext_base64":"bmV3VGV4dA=="}`),
			expectedCode: "PERMISSION_DENIED",
		},
		{
			name:         "MissingCiphertext_Rejected",
			sender:       aliceID,
			rawPayload:   []byte(`{"action":"edit_message","channel_id":"` + bobID + `","message_id":"` + msgID + `"}`),
			expectedCode: "MISSING_FIELDS",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockL := &mockLedgerRPC{
				authors: tt.ledgerAuthors,
				err:     tt.ledgerErr,
			}
			router, hub := setupTestRouter(mockL, nil)
			conn := newTestConn(hub, tt.sender, "dev_1")

			err := router.Handle(context.Background(), conn, tt.rawPayload)

			if tt.expectSuccess {
				if err != nil {
					t.Fatalf("unexpected Handle error: %v", err)
				}
				frames := readFrames(conn, 5, 200*time.Millisecond)
				if !hasFrameType(frames, "ack_edit") {
					t.Fatalf("expected ack_edit frame, got: %+v", frames)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error from Handle, got nil")
				}
				if !strings.Contains(err.Error(), tt.expectedCode) {
					t.Fatalf("expected error containing %s, got: %v", tt.expectedCode, err)
				}
				frames := readFrames(conn, 5, 200*time.Millisecond)
				code := getErrorCode(frames)
				if code != tt.expectedCode {
					t.Fatalf("expected error frame code %s, got: %s (frames: %+v)", tt.expectedCode, code, frames)
				}
			}
		})
	}
}

func TestTableDriven_PinMessage(t *testing.T) {
	aliceID := "usr_alice"
	bobID := "usr_bob"
	eveID := "usr_eve"
	channelID := "chan_group_1"
	msgID := "msg_pin_1"
	convID := channelID

	tests := []struct {
		name           string
		sender         string
		channelMembers []string
		channelErr     error
		ledgerAuthors  map[string]string
		ledgerErr      error
		rawPayload     []byte
		expectedCode   string
		expectSuccess  bool
	}{
		{
			name:           "ChannelMember_Succeeds",
			sender:         aliceID,
			channelMembers: []string{aliceID, bobID},
			ledgerAuthors: map[string]string{
				convID + ":" + msgID: aliceID,
			},
			rawPayload:    []byte(`{"action":"pin_message","channel_id":"` + channelID + `","message_id":"` + msgID + `","op":"pin"}`),
			expectSuccess: true,
		},
		{
			name:           "NonMember_Rejected_PermissionDenied",
			sender:         eveID, // Eve is not a member of group_1
			channelMembers: []string{aliceID, bobID},
			rawPayload:     []byte(`{"action":"pin_message","channel_id":"` + channelID + `","message_id":"` + msgID + `","op":"pin"}`),
			expectedCode:   "PERMISSION_DENIED",
		},
		{
			name:           "ChannelServiceError_FailsClosed_PermissionDenied",
			sender:         aliceID,
			channelErr:     errors.New("gRPC unavailable"),
			rawPayload:     []byte(`{"action":"pin_message","channel_id":"` + channelID + `","message_id":"` + msgID + `","op":"pin"}`),
			expectedCode:   "PERMISSION_DENIED",
		},
		{
			name:           "LedgerError_FailsClosed_PermissionDenied",
			sender:         aliceID,
			channelMembers: []string{aliceID, bobID},
			ledgerErr:      errors.New("ledger error"),
			rawPayload:     []byte(`{"action":"pin_message","channel_id":"` + channelID + `","message_id":"` + msgID + `","op":"pin"}`),
			expectedCode:   "PERMISSION_DENIED",
		},
		{
			name:         "MissingMessageID_Rejected",
			sender:       aliceID,
			rawPayload:   []byte(`{"action":"pin_message","channel_id":"` + channelID + `"}`),
			expectedCode: "MISSING_FIELDS",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockL := &mockLedgerRPC{
				authors: tt.ledgerAuthors,
				err:     tt.ledgerErr,
			}
			mockC := &mockChannelRPC{
				members: map[string][]string{
					"group_1": tt.channelMembers,
				},
				err: tt.channelErr,
			}
			router, hub := setupTestRouter(mockL, mockC)
			conn := newTestConn(hub, tt.sender, "dev_1")

			err := router.Handle(context.Background(), conn, tt.rawPayload)

			if tt.expectSuccess {
				if err != nil {
					t.Fatalf("unexpected Handle error: %v", err)
				}
				frames := readFrames(conn, 5, 200*time.Millisecond)
				if !hasFrameType(frames, "ack_pin") {
					t.Fatalf("expected ack_pin frame, got: %+v", frames)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error from Handle, got nil")
				}
				if !strings.Contains(err.Error(), tt.expectedCode) {
					t.Fatalf("expected error containing %s, got: %v", tt.expectedCode, err)
				}
				frames := readFrames(conn, 5, 200*time.Millisecond)
				code := getErrorCode(frames)
				if code != tt.expectedCode {
					t.Fatalf("expected error frame code %s, got: %s (frames: %+v)", tt.expectedCode, code, frames)
				}
			}
		})
	}
}
