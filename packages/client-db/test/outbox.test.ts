import assert from "node:assert";
import { LocalDatabase } from "../src/database";
import { OptimisticOutbox, CryptoEncryptor, WebSocketTransport } from "../src/sync/outbox";

test("OptimisticOutbox sends message with pending status and reconciles on server ACK", async () => {
  const db = new LocalDatabase();

  const mockCrypto: CryptoEncryptor = {
    encryptMessage: (_pickle, _key, plaintext) => {
      const text = typeof plaintext === "string" ? plaintext : new TextDecoder().decode(plaintext);
      return {
        message_type: 1,
        ciphertext_base64: Buffer.from(text).toString("base64"),
        updated_session_pickle: "updated_mock_pickle",
      };
    },
  };

  let sentPayload: any = null;
  const mockTransport: WebSocketTransport = {
    send: async (payload) => {
      sentPayload = payload;
      // Simulate server returning monotonic sequence number
      return {
        client_msg_id: payload.client_msg_id,
        message_id: "server_msg_1001",
        sequence_num: 42,
      };
    },
  };

  const outbox = new OptimisticOutbox(db, mockCrypto, mockTransport);

  // 1. Send optimistic message
  const msg = await outbox.send(
    "chan_room_1",
    "user_alice",
    "Hello Bob from Subway!",
    "mock_pickle",
    "mock_key"
  );

  // Instant local record check
  // Message dispatched and reconciled
  assert.ok(['pending', 'sent'].includes(msg.status));
  assert.strictEqual(msg.text, "Hello Bob from Subway!");
  assert.strictEqual(msg.channelId, "chan_room_1");

  // Wait for background dispatch to finish
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 2. Reconciled record check
  assert.strictEqual(msg.status, "sent", "After server ACK, status must reconcile to 'sent'");
  assert.strictEqual(msg.sequenceNum, 42, "Monotonic sequence number must be set");
  assert.ok(sentPayload, "Payload must have been sent over transport");
  assert.strictEqual(sentPayload.client_msg_id, msg.clientMsgId);
});
