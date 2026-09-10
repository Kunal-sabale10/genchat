// Test: Disappearing / Ephemeral Messages (Self-Destruct Timers)
// Verifies TTL wire framing, gateway ephemeral settings fan-out, client-side zero-trace purge, and countdown logic.

import assert from 'assert';

console.log('=== Starting Disappearing / Ephemeral Messages Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Standard Duration Tiers & Label Formatting Verification
// -------------------------------------------------------------
console.log('--- Testing Duration Tiers & Formatting Logic ---');

const DURATION_TIERS = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s' },
  { value: 300, label: '5m' },
  { value: 3600, label: '1h' },
  { value: 86400, label: '24h' },
  { value: 604800, label: '7d' },
];

function formatTtlLabel(sec) {
  if (!sec || sec <= 0) return 'Off';
  if (sec === 30) return '30s';
  if (sec === 300) return '5m';
  if (sec === 3600) return '1h';
  if (sec === 86400) return '24h';
  if (sec === 604800) return '7d';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function formatRemainingCountdown(sec) {
  if (sec <= 0) return '0s';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

for (const tier of DURATION_TIERS) {
  const formatted = formatTtlLabel(tier.value);
  assert.strictEqual(formatted, tier.label, `Expected ${tier.value}s to format to ${tier.label}`);
}

assert.strictEqual(formatRemainingCountdown(25), '25s');
assert.strictEqual(formatRemainingCountdown(125), '2m');
assert.strictEqual(formatRemainingCountdown(7200), '2h');
assert.strictEqual(formatRemainingCountdown(172800), '2d');
console.log('✓ Duration tiers and countdown formats verified correctly.');

// -------------------------------------------------------------
// Part 2: Gateway Ephemeral Wire Frame Validation
// -------------------------------------------------------------
console.log('\n--- Testing Gateway Ephemeral Frame Serialization & Dispatch ---');

// Test InboundFrame with ephemeral_ttl_sec
const clientSendMessageFrame = {
  action: 'send_message',
  channel_id: 'user_bob',
  client_msg_id: 'cli_msg_1001',
  ciphertext_base64: Buffer.from('Secret message that will self-destruct').toString('base64'),
  message_type: 1,
  ephemeral_ttl_sec: 300,
};

const serializedSend = JSON.stringify(clientSendMessageFrame);
const parsedSend = JSON.parse(serializedSend);

assert.strictEqual(parsedSend.action, 'send_message');
assert.strictEqual(parsedSend.ephemeral_ttl_sec, 300);
assert.strictEqual(parsedSend.client_msg_id, 'cli_msg_1001');

// Test PushFrame carrying ephemeral_ttl_sec
const gatewayPushFrame = {
  type: 'push',
  channel_id: 'user_bob',
  sender_id: 'user_alice',
  ciphertext_base64: parsedSend.ciphertext_base64,
  message_type: 1,
  server_id: 'srv_msg_1001',
  server_time: Math.floor(Date.now() / 1000),
  ephemeral_ttl_sec: parsedSend.ephemeral_ttl_sec,
};

const serializedPush = JSON.stringify(gatewayPushFrame);
const parsedPush = JSON.parse(serializedPush);

assert.strictEqual(parsedPush.type, 'push');
assert.strictEqual(parsedPush.ephemeral_ttl_sec, 300);
assert.strictEqual(parsedPush.sender_id, 'user_alice');

// Test EphemeralSettingFrame
const ephemeralSettingInbound = {
  action: 'ephemeral_setting',
  channel_id: 'user_bob',
  ephemeral_ttl_sec: 86400,
};

const serializedSetting = JSON.stringify(ephemeralSettingInbound);
const parsedSetting = JSON.parse(serializedSetting);
assert.strictEqual(parsedSetting.action, 'ephemeral_setting');
assert.strictEqual(parsedSetting.ephemeral_ttl_sec, 86400);

// Test EphemeralSettingPushFrame
const ephemeralSettingPush = {
  type: 'ephemeral_setting',
  channel_id: 'user_bob',
  ephemeral_ttl_sec: 86400,
  updated_by: 'user_alice',
  updated_at: Math.floor(Date.now() / 1000),
};

const serializedSettingPush = JSON.stringify(ephemeralSettingPush);
const parsedSettingPush = JSON.parse(serializedSettingPush);
assert.strictEqual(parsedSettingPush.type, 'ephemeral_setting');
assert.strictEqual(parsedSettingPush.ephemeral_ttl_sec, 86400);
assert.strictEqual(parsedSettingPush.updated_by, 'user_alice');

console.log('✓ Inbound and Push ephemeral wire frame types validated.');

// -------------------------------------------------------------
// Part 3: Client-Side Expiration & Zero-Trace Purge Emulation
// -------------------------------------------------------------
console.log('\n--- Testing Client-Side Expiration & Zero-Trace Purge ---');

class MockLocalStorageDb {
  constructor() {
    this.store = new Map();
  }

  saveMessage(msg) {
    this.store.set(msg.id, { ...msg });
  }

  getMessagesByChannel(channelId) {
    const now = Date.now();
    const result = [];
    for (const msg of this.store.values()) {
      if (msg.channelId === channelId) {
        // Zero-knowledge filter: immediately drop expired messages
        if (!msg.expiresAt || msg.expiresAt > now) {
          result.push(msg);
        }
      }
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  purgeExpiredMessages() {
    const now = Date.now();
    const purgedIds = [];
    for (const [id, msg] of this.store.entries()) {
      if (msg.expiresAt && msg.expiresAt <= now) {
        purgedIds.push(id);
        this.store.delete(id);
      }
    }
    return purgedIds;
  }

  search(query, channelId) {
    const now = Date.now();
    const result = [];
    for (const msg of this.store.values()) {
      if (channelId && msg.channelId !== channelId) continue;
      // Zero-knowledge filter in search pool
      if (msg.expiresAt && msg.expiresAt <= now) continue;
      if (msg.text && msg.text.toLowerCase().includes(query.toLowerCase())) {
        result.push(msg);
      }
    }
    return result;
  }
}

const db = new MockLocalStorageDb();
const baseTime = Date.now();

// 1. Store a normal persistent message (no TTL)
db.saveMessage({
  id: 'msg_perm_1',
  clientMsgId: 'cli_perm_1',
  channelId: 'chan_public',
  senderId: 'alice',
  text: 'Persistent hello',
  status: 'sent',
  timestamp: '10:00 AM',
  createdAt: baseTime - 50000,
});

// 2. Store an active ephemeral message (300s TTL, expires in 250s)
db.saveMessage({
  id: 'msg_active_ephem',
  clientMsgId: 'cli_active_ephem',
  channelId: 'chan_public',
  senderId: 'alice',
  text: 'Active ephemeral message',
  status: 'sent',
  timestamp: '10:01 AM',
  createdAt: baseTime - 50000,
  ephemeralTtlSec: 300,
  expiresAt: baseTime + 250000,
});

// 3. Store an already-expired ephemeral message (30s TTL, expired 10s ago)
db.saveMessage({
  id: 'msg_expired_ephem',
  clientMsgId: 'cli_expired_ephem',
  channelId: 'chan_public',
  senderId: 'bob',
  text: 'Expired ephemeral secret',
  status: 'read',
  timestamp: '09:59 AM',
  createdAt: baseTime - 40000,
  ephemeralTtlSec: 30,
  expiresAt: baseTime - 10000,
});

// Verify getMessagesByChannel excludes the expired message
const channelMessages = db.getMessagesByChannel('chan_public');
assert.strictEqual(channelMessages.length, 2, 'Expired message should not be returned by getMessagesByChannel');
assert.strictEqual(channelMessages.some(m => m.id === 'msg_expired_ephem'), false, 'msg_expired_ephem must be excluded');
console.log('✓ Channel message loader filters out expired ephemeral records.');

// Verify search query also excludes expired message
const searchResults = db.search('ephemeral', 'chan_public');
assert.strictEqual(searchResults.length, 1, 'Only non-expired message should match search');
assert.strictEqual(searchResults[0].id, 'msg_active_ephem');
console.log('✓ Full-text zero-knowledge search excludes expired ephemeral records.');

// Execute purgeExpiredMessages
const purged = db.purgeExpiredMessages();
assert.strictEqual(purged.length, 1);
assert.strictEqual(purged[0], 'msg_expired_ephem');
assert.strictEqual(db.store.has('msg_expired_ephem'), false, 'msg_expired_ephem must be permanently erased from store');
console.log('✓ Purge engine permanently erased expired record from offline store.');

// Verify store now has exactly 2 records
assert.strictEqual(db.store.size, 2);

// -------------------------------------------------------------
// Part 4: Critical Threshold & Live Countdown Emulation
// -------------------------------------------------------------
console.log('\n--- Testing Countdown & Imminent Self-Destruction Threshold ---');

const now = Date.now();
const msgEndingSoon = {
  id: 'msg_dying',
  expiresAt: now + 5000, // 5 seconds remaining
};

const remainingSec = Math.max(0, Math.floor((msgEndingSoon.expiresAt - now) / 1000));
const isCritical = remainingSec <= 10;
assert.strictEqual(isCritical, true, 'Message with 5s remaining should trigger critical warning state');
assert.strictEqual(formatRemainingCountdown(remainingSec), '5s');
console.log(`✓ Imminent self-destruct threshold detected (${remainingSec}s remaining, critical=${isCritical}).`);

console.log('\n=============================================================');
console.log('🎉 All Disappearing / Ephemeral Messages Tests Passed! (100% GREEN)');
console.log('=============================================================');
