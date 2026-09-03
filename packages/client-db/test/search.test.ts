import assert from "node:assert";
import { test } from "node:test";
import { LocalDatabase } from "../src/database.js";
import { ZeroKnowledgeSearchEngine } from "../src/search/search.js";
import { Message } from "../src/models/Message.js";

test("ZeroKnowledgeSearchEngine searches decrypted messages with ranking and prefix matching", async () => {
  const db = new LocalDatabase();
  const messagesCol = db.get("messages");

  // Populate sample decrypted messages
  await messagesCol.create((m: Message) => {
    m.id = "m1";
    m.channelId = "room_general";
    m.text = "The post-quantum key exchange protocol is finalized";
    m.createdAt = new Date(Date.now() - 2000);
  });

  await messagesCol.create((m: Message) => {
    m.id = "m2";
    m.channelId = "room_random";
    m.text = "Let's meet at 5pm for lunch";
    m.createdAt = new Date(Date.now() - 1000);
  });

  await messagesCol.create((m: Message) => {
    m.id = "m3";
    m.channelId = "room_general";
    m.text = "Post-quantum cryptography prevents harvesting attacks";
    m.createdAt = new Date();
  });

  const searchEngine = new ZeroKnowledgeSearchEngine(db);

  // 1. Multi-word search
  const res1 = await searchEngine.search("post-quantum cryptography");
  assert.strictEqual(res1.length, 1);
  assert.strictEqual(res1[0].message.id, "m3");

  // 2. Prefix / partial term search
  const res2 = await searchEngine.search("protocol*");
  assert.strictEqual(res2.length, 1);
  assert.strictEqual(res2[0].message.id, "m1");

  // 3. Channel-scoped search
  const res3 = await searchEngine.search("quantum", { channelId: "room_random" });
  assert.strictEqual(res3.length, 0, "Query for 'quantum' in room_random must return 0 results");

  const res4 = await searchEngine.search("quantum", { channelId: "room_general" });
  assert.strictEqual(res4.length, 2, "Query for 'quantum' in room_general must return 2 results");
});
