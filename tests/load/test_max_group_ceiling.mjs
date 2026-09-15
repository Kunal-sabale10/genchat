import assert from 'assert';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Load Test: MLS Group Size Ceiling Enforcement ===\n');

async function provisionUser(name) {
  const res = await fetch(`${AUTH_HTTP_URL}/dev-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: name, user_id: crypto.randomUUID(), device_id: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`Failed to provision user: ${res.status}`);
  return await res.json();
}

async function run() {
  const creator = await provisionUser('Group Creator');
  console.log(`✓ Provisioned group creator (${creator.user_id})`);

  const MAX_CEILING = 256;
  console.log(`Enforcing maximum group size ceiling of ${MAX_CEILING} members...`);

  // 1. Create a member list of 256 members (including creator)
  console.log(`Provisioning ${MAX_CEILING - 1} members in concurrent batches...`);
  const memberUserIds = [];
  const batchSize = 25;
  for (let i = 0; i < MAX_CEILING - 1; i += batchSize) {
    const chunk = Math.min(batchSize, (MAX_CEILING - 1) - i);
    const users = await Promise.all(
      Array.from({ length: chunk }, (_, idx) => provisionUser(`Member_${i + idx}`))
    );
    memberUserIds.push(...users.map((u) => u.user_id));
  }
  console.log(`✓ Provisioned all ${memberUserIds.length} members successfully.`);

  const startTime = Date.now();
  const createRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.ChannelService/CreateChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creator.access_token}`,
    },
    body: JSON.stringify({
      name: 'Ceiling Load Group',
      type: 1, // GROUP
      member_user_ids: memberUserIds,
    }),
  });

  const createElapsed = Date.now() - startTime;
  assert.strictEqual(createRes.status, 200, `Creating group of ${MAX_CEILING} members should succeed`);
  const createData = await createRes.json();
  const channelId = createData.channel?.id;
  assert.ok(channelId, 'Channel ID should exist');
  assert.strictEqual(createData.members?.length, MAX_CEILING, `Should have exactly ${MAX_CEILING} members`);
  console.log(`✓ Group created at ceiling of ${MAX_CEILING} members in ${createElapsed}ms.`);

  // 2. Attempt to create a group exceeding the ceiling (257 members) -> must fail closed
  const overCeilingMembers = [];
  for (let i = 0; i < MAX_CEILING; i++) {
    overCeilingMembers.push(crypto.randomUUID());
  }
  // Total including creator = 257
  const overCeilingRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.ChannelService/CreateChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creator.access_token}`,
    },
    body: JSON.stringify({
      name: 'Over Ceiling Group',
      type: 1,
      member_user_ids: overCeilingMembers,
    }),
  });

  assert.notStrictEqual(overCeilingRes.status, 200, 'Creation exceeding ceiling must be rejected');
  console.log(`✓ Rejection of group creation at 257 members verified (HTTP ${overCeilingRes.status}).`);

  // 3. Attempt to join the existing 256-member group with a 257th user -> must fail with capacity exhaustion
  const extraUser = await provisionUser('Extra User');
  const joinRes = await fetch(`${AUTH_HTTP_URL}/chat.v1.ChannelService/JoinChannel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${extraUser.access_token}`,
    },
    body: JSON.stringify({
      channel_id: channelId,
    }),
  });

  assert.notStrictEqual(joinRes.status, 200, 'Joining a group at capacity must be rejected');
  console.log(`✓ Rejection of JoinChannel on max-capacity group verified (HTTP ${joinRes.status}).`);

  console.log('\n=== All Group Ceiling Enforcement Tests Passed! ===\n');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
