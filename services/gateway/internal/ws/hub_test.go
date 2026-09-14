package ws

import (
	"bytes"
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
