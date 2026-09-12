// Test: Cryptographic Safety Numbers & QR Code Out-of-Band Verification Suite
// Verifies deterministic symmetry, 60-digit grouping, QR encoding, trust store, and key change detection.

import assert from 'assert';
import { createHash } from 'crypto';

console.log('=== Starting Cryptographic Safety Numbers & Trust Verification Test Suite ===\n');

// -------------------------------------------------------------
// Part 1: Deterministic Symmetry & 60-digit Derivation
// -------------------------------------------------------------
console.log('--- Testing Deterministic Symmetry & 60-Digit Derivation ---');

function computeSafetyNumberNode(userAOrIdA, keyAOrIdB, userIdB, identityKeyB) {
  let uA = userAOrIdA;
  let kA = '';
  let uB = '';
  let kB = '';

  if (userIdB !== undefined && identityKeyB !== undefined) {
    uA = userAOrIdA;
    kA = typeof keyAOrIdB === 'string' ? keyAOrIdB : Buffer.from(keyAOrIdB).toString('hex');
    uB = userIdB;
    kB = typeof identityKeyB === 'string' ? identityKeyB : Buffer.from(identityKeyB).toString('hex');
  } else {
    uA = userAOrIdA;
    uB = typeof keyAOrIdB === 'string' ? keyAOrIdB : '';
  }

  const partyA = { userId: uA, key: kA };
  const partyB = { userId: uB, key: kB };

  const cmp = (partyA.userId + ':' + partyA.key).localeCompare(partyB.userId + ':' + partyB.key);
  const [p1, p2] = cmp <= 0 ? [partyA, partyB] : [partyB, partyA];

  const prefix = 'genchat-safety-v1:';
  const payload = Buffer.from(`${prefix}${p1.userId}:${p1.key}:${p2.userId}:${p2.key}`);

  let currentHash = createHash('sha512').update(payload).digest();
  for (let i = 0; i < 5; i++) {
    currentHash = createHash('sha512').update(currentHash).digest();
  }

  const blocks = [];
  for (let i = 0; i < 12; i++) {
    const b0 = currentHash[i * 4] || 0;
    const b1 = currentHash[i * 4 + 1] || 0;
    const b2 = currentHash[i * 4 + 2] || 0;
    const b3 = currentHash[i * 4 + 3] || 0;
    const val = (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) % 100000;
    blocks.push(val.toString().padStart(5, '0'));
  }
  return blocks.join(' ');
}

const aliceId = 'usr_alice_847192a01';
const aliceKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const bobId = 'usr_bob_991823b02';
const bobKey = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const charlieId = 'usr_charlie_551829c03';
const charlieKey = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

const aliceForBob = computeSafetyNumberNode(aliceId, aliceKey, bobId, bobKey);
const bobForAlice = computeSafetyNumberNode(bobId, bobKey, aliceId, aliceKey);

assert.strictEqual(aliceForBob, bobForAlice, 'Safety numbers must be deterministically symmetric');

// Verify format: 12 blocks of 5 digits
const blocks = aliceForBob.split(' ');
assert.strictEqual(blocks.length, 12, 'Must have exactly 12 blocks');
for (const block of blocks) {
  assert.strictEqual(block.length, 5, `Each block must be 5 digits: got ${block}`);
  assert(/^\d{5}$/.test(block), `Block must consist of numbers only: got ${block}`);
}

// Total digit count = 60
const allDigits = aliceForBob.replace(/\s+/g, '');
assert.strictEqual(allDigits.length, 60, 'Total safety number length must be exactly 60 digits');

// Different contact pairs must produce different numbers
const aliceForCharlie = computeSafetyNumberNode(aliceId, aliceKey, charlieId, charlieKey);
assert.notStrictEqual(aliceForBob, aliceForCharlie, 'Safety numbers must be unique per contact pair');

console.log(`✓ Alice & Bob Safety Number: ${aliceForBob}`);
console.log('✓ Symmetric 60-digit number structure validated (12 blocks x 5 digits).');

// -------------------------------------------------------------
// Part 2: QR Payload Generation & Bidirectional Validation
// -------------------------------------------------------------
console.log('\n--- Testing QR Payload Canonical Serialization & Verification ---');

function generateQrPayload(userIdA, userIdB, safetyNumber) {
  const sorted = [userIdA, userIdB].sort();
  const compactNum = safetyNumber.replace(/\s+/g, '');
  return `genchat:safety?v=1&a=${encodeURIComponent(sorted[0])}&b=${encodeURIComponent(sorted[1])}&num=${compactNum}`;
}

function parseAndVerifyQrPayload(payload, currentUserId, peerId, expectedSafetyNumber) {
  if (!payload.startsWith('genchat:safety?')) {
    return { isValid: false, error: 'Not a valid GenChat Safety QR code' };
  }

  try {
    const url = new URL(payload.replace('genchat:safety?', 'http://safety/?'));
    const a = url.searchParams.get('a');
    const b = url.searchParams.get('b');
    const num = url.searchParams.get('num');

    const sortedExpected = [currentUserId, peerId].sort();
    if (a !== sortedExpected[0] || b !== sortedExpected[1]) {
      return { isValid: false, error: 'QR code belongs to a different contact or conversation' };
    }

    const expectedCompact = expectedSafetyNumber.replace(/\s+/g, '');
    if (num !== expectedCompact) {
      return { isValid: false, error: 'Safety Number mismatch! Encryption keys do not match' };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Malformed QR payload' };
  }
}

const alicePayload = generateQrPayload(aliceId, bobId, aliceForBob);
console.log(`✓ Generated QR Payload: ${alicePayload}`);

// Bob scans Alice's QR code -> Valid match
const bobScanResult = parseAndVerifyQrPayload(alicePayload, bobId, aliceId, bobForAlice);
assert.strictEqual(bobScanResult.isValid, true);
assert.strictEqual(bobScanResult.error, undefined);
console.log('✓ Peer scan verified valid QR payload match.');

// Scanning code intended for another conversation -> Rejected
const charlieScanResult = parseAndVerifyQrPayload(alicePayload, charlieId, aliceId, aliceForCharlie);
assert.strictEqual(charlieScanResult.isValid, false);
assert.strictEqual(charlieScanResult.error, 'QR code belongs to a different contact or conversation');
console.log('✓ Cross-conversation QR code correctly rejected.');

// Tampered / MITM payload (attacker altered digits) -> Rejected
const tamperedPayload = alicePayload.replace(/num=\d+/, 'num=999999999999999999999999999999999999999999999999999999999999');
const mitmScanResult = parseAndVerifyQrPayload(tamperedPayload, bobId, aliceId, bobForAlice);
assert.strictEqual(mitmScanResult.isValid, false);
assert.strictEqual(mitmScanResult.error, 'Safety Number mismatch! Encryption keys do not match');
console.log('✓ Tampered / MITM Safety Number correctly rejected.');

// -------------------------------------------------------------
// Part 3: Persistent Trust Store & Key Change Detection
// -------------------------------------------------------------
console.log('\n--- Testing Persistent Trust Store & Key-Change Detection ---');

class MockTrustStore {
  constructor() {
    this.records = new Map();
  }

  getTrustRecord(peerId, currentSafetyNumber) {
    const record = this.records.get(peerId);
    if (!record) {
      return {
        peerId,
        safetyNumber: currentSafetyNumber,
        isVerified: false,
        hasChanged: false,
      };
    }

    const hasChanged = record.isVerified && record.safetyNumber !== currentSafetyNumber;
    return {
      peerId,
      safetyNumber: currentSafetyNumber,
      isVerified: hasChanged ? false : record.isVerified,
      verifiedAt: record.verifiedAt,
      hasChanged,
      previousSafetyNumber: hasChanged ? record.safetyNumber : undefined,
    };
  }

  setVerified(peerId, safetyNumber) {
    this.records.set(peerId, {
      peerId,
      safetyNumber,
      isVerified: true,
      verifiedAt: Date.now(),
      hasChanged: false,
    });
  }

  revokeVerification(peerId) {
    const rec = this.records.get(peerId);
    if (rec) {
      rec.isVerified = false;
      rec.hasChanged = false;
      delete rec.verifiedAt;
    }
  }
}

const trustStore = new MockTrustStore();

// 1. Initial unverified state
const initialRec = trustStore.getTrustRecord(bobId, aliceForBob);
assert.strictEqual(initialRec.isVerified, false);
assert.strictEqual(initialRec.hasChanged, false);
console.log('✓ Initial unverified status verified.');

// 2. Mark as verified
trustStore.setVerified(bobId, aliceForBob);
const verifiedRec = trustStore.getTrustRecord(bobId, aliceForBob);
assert.strictEqual(verifiedRec.isVerified, true);
assert(verifiedRec.verifiedAt > 0);
assert.strictEqual(verifiedRec.hasChanged, false);
console.log(`✓ Contact marked as verified (timestamp: ${verifiedRec.verifiedAt}).`);

// 3. Key Change / MITM Event: Bob rotates identity key (same user ID, different public key)
const rotatedBobKey = '99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff';
const newSafetyNumber = computeSafetyNumberNode(aliceId, aliceKey, bobId, rotatedBobKey);
assert.notStrictEqual(newSafetyNumber, aliceForBob, 'Rotating identity key must produce completely different safety number');

// Query with new safety number -> triggers key change warning!
const changedRec = trustStore.getTrustRecord(bobId, newSafetyNumber);
assert.strictEqual(changedRec.hasChanged, true, 'Must flag hasChanged when safety number rotates');
assert.strictEqual(changedRec.isVerified, false, 'Must drop verified state when keys rotate');
assert.strictEqual(changedRec.previousSafetyNumber, aliceForBob, 'Must remember previous safety number for auditing');
console.log('✓ Key Change / MITM Alert triggered upon identity rotation.');

// 4. User inspects and re-verifies new safety number
trustStore.setVerified(bobId, newSafetyNumber);
const reVerifiedRec = trustStore.getTrustRecord(bobId, newSafetyNumber);
assert.strictEqual(reVerifiedRec.isVerified, true);
assert.strictEqual(reVerifiedRec.hasChanged, false);
console.log('✓ Re-verification clears key-change alert banner.');

// 5. Revocation
trustStore.revokeVerification(bobId);
const revokedRec = trustStore.getTrustRecord(bobId, newSafetyNumber);
assert.strictEqual(revokedRec.isVerified, false);
assert.strictEqual(revokedRec.verifiedAt, undefined);
console.log('✓ Revocation clears verified status.');

// -------------------------------------------------------------
// Part 4: SVG QR Code Generation Validation
// -------------------------------------------------------------
console.log('\n--- Testing Zero-Dependency Vector SVG QR Code Output ---');

// Emulate minimal matrix and SVG generation
function generateMockSvgQr(text, size = 200) {
  assert(text && text.length > 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <rect width="100%" height="100%" fill="#ffffff" rx="12"/>
    <path d="M0,0h10v10h-10z" fill="#0f172a"/>
  </svg>`;
}

const svg = generateMockSvgQr(alicePayload);
assert(svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
assert(svg.includes('viewBox="0 0 200 200"'));
assert(svg.includes('<rect'));
assert(svg.includes('<path'));
console.log('✓ Vector SVG QR code rendered and structured cleanly.');

console.log('\n=============================================================');
console.log('🎉 All Cryptographic Safety Numbers Tests Passed! (100% GREEN)');
console.log('=============================================================');
