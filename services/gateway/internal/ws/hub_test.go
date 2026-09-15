package ws

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

func TestHub_RegisterAndUnregister(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	conn1 := &Conn{
		ID:       "c1",
		UserID:   "user1",
		DeviceID: "dev1",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}

	conn2 := &Conn{
		ID:       "c2",
		UserID:   "user1",
		DeviceID: "dev2",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}

	hub.Register(conn1)
	hub.Register(conn2)

	// Wait briefly for hub loop
	time.Sleep(50 * time.Millisecond)

	if !hub.IsOnline("user1") {
		t.Errorf("expected user1 to be online")
	}
	if hub.IsOnline("user2") {
		t.Errorf("expected user2 to be offline")
	}
	if cnt := hub.OnlineCount(); cnt != 1 {
		t.Errorf("expected 1 online user, got %d", cnt)
	}
	if devCnt := hub.GetActiveDeviceCount("user1"); devCnt != 2 {
		t.Errorf("expected 2 active devices for user1, got %d", devCnt)
	}

	hub.Unregister(conn1)
	time.Sleep(50 * time.Millisecond)

	if devCnt := hub.GetActiveDeviceCount("user1"); devCnt != 1 {
		t.Errorf("expected 1 active device after unregistering conn1, got %d", devCnt)
	}
	if !hub.IsOnline("user1") {
		t.Errorf("expected user1 to still be online with conn2")
	}

	hub.Unregister(conn2)
	time.Sleep(50 * time.Millisecond)

	if hub.IsOnline("user1") {
		t.Errorf("expected user1 to be offline after unregistering all conns")
	}
	if cnt := hub.OnlineCount(); cnt != 0 {
		t.Errorf("expected 0 online users, got %d", cnt)
	}
}

func TestHub_SendToUser(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	connA1 := &Conn{
		ID:       "cA1",
		UserID:   "userA",
		DeviceID: "devA1",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}
	connA2 := &Conn{
		ID:       "cA2",
		UserID:   "userA",
		DeviceID: "devA2",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}
	connB := &Conn{
		ID:       "cB",
		UserID:   "userB",
		DeviceID: "devB",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}

	hub.Register(connA1)
	hub.Register(connA2)
	hub.Register(connB)
	time.Sleep(50 * time.Millisecond)

	payload := []byte("hello userA")
	hub.SendToUser("userA", payload)

	select {
	case msg := <-connA1.Send:
		if !bytes.Equal(msg, payload) {
			t.Fatalf("connA1 received wrong payload: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timeout waiting for msg on connA1")
	}

	select {
	case msg := <-connA2.Send:
		if !bytes.Equal(msg, payload) {
			t.Fatalf("connA2 received wrong payload: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timeout waiting for msg on connA2")
	}

	select {
	case msg := <-connB.Send:
		t.Fatalf("connB should not have received message, got: %s", msg)
	default:
		// expected
	}
}

func TestHub_SendToDevice(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	conn1 := &Conn{
		ID:       "c1",
		UserID:   "user1",
		DeviceID: "phone",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}
	conn2 := &Conn{
		ID:       "c2",
		UserID:   "user1",
		DeviceID: "desktop",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}

	hub.Register(conn1)
	hub.Register(conn2)
	time.Sleep(50 * time.Millisecond)

	payload := []byte("desktop-only alert")
	hub.SendToDevice("user1", "desktop", payload)

	select {
	case msg := <-conn2.Send:
		if !bytes.Equal(msg, payload) {
			t.Fatalf("desktop received wrong payload: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timeout waiting for msg on desktop")
	}

	select {
	case msg := <-conn1.Send:
		t.Fatalf("phone should not have received message, got: %s", msg)
	default:
		// expected
	}
}

func TestHub_BroadcastAll(t *testing.T) {
	hub := NewHub()
	go hub.Run()

	connA := &Conn{
		ID:       "cA",
		UserID:   "userA",
		DeviceID: "devA",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}
	connB := &Conn{
		ID:       "cB",
		UserID:   "userB",
		DeviceID: "devB",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}

	hub.Register(connA)
	hub.Register(connB)
	time.Sleep(50 * time.Millisecond)

	payload := []byte("announcement")
	// Exclude userA
	hub.BroadcastAll("userA", payload)

	select {
	case msg := <-connB.Send:
		if !bytes.Equal(msg, payload) {
			t.Fatalf("userB received wrong payload: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timeout waiting for msg on connB")
	}

	select {
	case msg := <-connA.Send:
		t.Fatalf("userA should have been excluded, got: %s", msg)
	default:
		// expected
	}
}

type mockDirectoryRouter struct {
	sync.Mutex
	registered   map[string]string
	deregistered map[string]string
	podGateways  map[string][]string
	published    []struct {
		podID   string
		userID  string
		payload []byte
	}
}

func newMockDirectoryRouter() *mockDirectoryRouter {
	return &mockDirectoryRouter{
		registered:   make(map[string]string),
		deregistered: make(map[string]string),
		podGateways:  make(map[string][]string),
	}
}

func (m *mockDirectoryRouter) RegisterUserGateway(ctx context.Context, userID, instanceID string) error {
	m.Lock()
	defer m.Unlock()
	m.registered[userID] = instanceID
	return nil
}

func (m *mockDirectoryRouter) DeregisterUserGateway(ctx context.Context, userID, instanceID string) error {
	m.Lock()
	defer m.Unlock()
	m.deregistered[userID] = instanceID
	return nil
}

func (m *mockDirectoryRouter) GetUserGateways(ctx context.Context, userID string) ([]string, error) {
	m.Lock()
	defer m.Unlock()
	return m.podGateways[userID], nil
}

func (m *mockDirectoryRouter) PublishToPod(ctx context.Context, targetPodID string, targetUserID string, payload []byte) error {
	m.Lock()
	defer m.Unlock()
	m.published = append(m.published, struct {
		podID   string
		userID  string
		payload []byte
	}{podID: targetPodID, userID: targetUserID, payload: payload})
	return nil
}

func TestHub_CrossPodRouting(t *testing.T) {
	mockRouter := newMockDirectoryRouter()
	mockRouter.podGateways["remoteUser"] = []string{"pod-beta"}

	hub := NewHubWithRouter("pod-alpha", mockRouter)
	go hub.Run()

	localConn := &Conn{
		ID:       "cLocal",
		UserID:   "localUser",
		DeviceID: "dev1",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}
	hub.Register(localConn)
	time.Sleep(50 * time.Millisecond)

	// Verify localUser was registered in directory router
	mockRouter.Lock()
	if pod, ok := mockRouter.registered["localUser"]; !ok || pod != "pod-alpha" {
		t.Fatalf("expected localUser to be registered on pod-alpha, got %v", pod)
	}
	mockRouter.Unlock()

	// Send message to remote user on pod-beta
	payload := []byte("cross-pod secret")
	hub.SendToUser("remoteUser", payload)
	time.Sleep(100 * time.Millisecond)

	mockRouter.Lock()
	if len(mockRouter.published) != 1 {
		t.Fatalf("expected 1 cross-pod publish, got %d", len(mockRouter.published))
	}
	pub := mockRouter.published[0]
	if pub.podID != "pod-beta" || pub.userID != "remoteUser" || !bytes.Equal(pub.payload, payload) {
		t.Fatalf("unexpected publish details: %+v", pub)
	}
	mockRouter.Unlock()

	// Verify DeliverLocal delivers directly without remote routing
	inboundCrossPod := []byte("delivered from pod-gamma")
	hub.DeliverLocal("localUser", inboundCrossPod)

	select {
	case msg := <-localConn.Send:
		if !bytes.Equal(msg, inboundCrossPod) {
			t.Fatalf("expected inboundCrossPod payload, got: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timeout waiting for DeliverLocal message on localConn")
	}

	// Unregister and verify deregistration from router
	hub.Unregister(localConn)
	time.Sleep(50 * time.Millisecond)

	mockRouter.Lock()
	if pod, ok := mockRouter.deregistered["localUser"]; !ok || pod != "pod-alpha" {
		t.Fatalf("expected localUser to be deregistered from pod-alpha, got %v", pod)
	}
	mockRouter.Unlock()
}

func TestHub_Drain(t *testing.T) {
	mockRouter := newMockDirectoryRouter()
	hub := NewHubWithRouter("pod-alpha", mockRouter)
	go hub.Run()

	conn := &Conn{
		ID:       "cDraining",
		UserID:   "userDraining",
		DeviceID: "devDrain",
		Send:     make(chan []byte, 10),
		Hub:      hub,
	}
	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	reconnectNotice := []byte(`{"type":"reconnect","reason":"server_shutdown"}`)
	drainCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go hub.Drain(drainCtx, reconnectNotice)

	select {
	case msg := <-conn.Send:
		if !bytes.Equal(msg, reconnectNotice) {
			t.Fatalf("expected reconnectNotice, got %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("timeout waiting for reconnectNotice on draining connection")
	}

	mockRouter.Lock()
	if _, ok := mockRouter.deregistered["userDraining"]; !ok {
		t.Fatalf("expected userDraining to be deregistered during drain")
	}
	mockRouter.Unlock()
}

