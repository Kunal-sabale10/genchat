import assert from "node:assert";
import { test } from "node:test";
import { LocalDatabase } from "../src/database.js";
import { InboundSyncReconciler, CryptoDecryptor } from "../src/sync/reconciler.js";
import { Channel } from "../src/models/Channel.js";

test("InboundSyncReconciler batches incoming messages and decrypts via Wasm", async () => {
  const db = new LocalDatabase();

  // Create local channel
  const channelCol = db.get("channels");
  await channelCol.create((c: Channel) => {
    c.id = "chan_room_1";
    c.name = "Engineering";
    c.channelType = "group";
    c.unreadCount = 0;
  });

  const mockCrypto: CryptoDecryptor = {
    decryptMessage: (_pickle, _key, _type, ctBase64) => {
      const decoded = Buffer.from(ctBase64, "base64").toString("utf-8");
      return {
        plaintext: new TextEncoder().encode("Decrypted: " + decoded),
        updated_session_pickle: "updated_pickle",
      };
    },
  };

  const reconciler = new InboundSyncReconciler(db, mockCrypto, 10);

  // Queue 3 messages in rapid succession
  reconciler.enqueue({
    channel_id: "chan_room_1",
    sender_id: "user_bob",
    message_id: "msg_1",
    sequence_num: 1,
    ciphertext_base64: Buffer.from("First message").toString("base64"),
    message_type: 1,
    session_pickle: "mock_pickle",
    pickle_key_hex: "mock_key",
  });

  reconciler.enqueue({
    channel_id: "chan_room_1",
    sender_id: "user_charlie",
    message_id: "msg_2",
    sequence_num: 2,
    ciphertext_base64: Buffer.from("Second message").toString("base64"),
    message_type: 1,
    session_pickle: "mock_pickle",
    pickle_key_hex: "mock_key",
  });

  // Flush batch
  const count = await reconciler.flushQueue();
  assert.strictEqual(count, 2, "Batch must have processed 2 messages");

  // Verify messages written to local DB
  const messagesCol = db.get("messages");
  const storedMsgs = messagesCol.all();
  assert.strictEqual(storedMsgs.length, 2);
  assert.strictEqual(storedMsgs[0].text, "Decrypted: First message");
  assert.strictEqual(storedMsgs[1].text, "Decrypted: Second message");

  // Verify channel unread count incremented
  const channel = await channelCol.find("chan_room_1");
  assert.strictEqual(channel?.unreadCount, 2, "Unread count must be 2");
});
