# Native Platform VoIP & Background Execution Specifications

This specification outlines the native bridge architectures for iOS (CallKit / PushKit) and Android (ConnectionService / TelecomManager), ensuring full privacy and zero plaintext leakage.

---

## 📱 1. iOS: CallKit & PushKit VoIP Integration

### A. PushKit Silent Wakeup Payload
Apple requires VoIP pushes to report an incoming call immediately to `CXProvider` (CallKit):

```json
{
  "aps": {
    "content-available": 1,
    "apns-priority": 10
  },
  "call_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "caller_handle": "alice-device-1",
  "call_type": "audio",
  "sframe_pub": "base64-encoded-ephemeral-x25519-key"
}
```

### B. CallKit Lifecycle Sequence
1. `PKPushRegistryDelegate.didReceiveIncomingPushWith`:
   - Extracts `call_id` and caller handle.
   - Instantiates `CXCallUpdate` with `hasVideo = false` (or `true`).
   - Calls `provider.reportNewIncomingCall(with: UUID(uuidString: call_id), update: update)`.
2. User Accepts Call (`CXProviderDelegate.performAnswerCallAction`):
   - Initializes WebRTC PeerConnection with SFrame Insertable Streams transform.
   - Sends `CallAnswerAction` over WebSocket or REST fallback.
3. User Rejects/Ends Call (`performEndCallAction`):
   - Sends `CallStatusAction(state: "rejected" | "ended")`.

---

## 🤖 2. Android: ConnectionService & TelecomManager

### A. High-Priority FCM Data-Only Payload
```json
{
  "priority": "high",
  "data": {
    "call_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "caller_handle": "alice-device-1",
    "call_type": "video",
    "sframe_pub": "base64-encoded-ephemeral-x25519-key"
  }
}
```

### B. ConnectionService Architecture
1. `FirebaseMessagingService.onMessageReceived`:
   - Builds `TelecomManager.addNewIncomingCall(phoneAccountHandle, extras)`.
2. `GenChatConnectionService.onCreateIncomingConnection`:
   - Creates `Connection` object with `PROPERTY_SELF_MANAGED` and `CAPABILITY_HOLD`.
   - Fires system ringing notifications and fullscreen incoming call intent.
3. Call State Transitions:
   - `onAnswer()`: Connects audio/video track via SFrame WebRTC transform.
   - `onReject()` / `onDisconnect()`: Tear down WebRTC session.
