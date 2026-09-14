import assert from 'assert';
import { execSync } from 'child_process';

const AUTH_HTTP_URL = process.env.AUTH_HTTP_URL || 'http://127.0.0.1:8080';

console.log('=== Test: GDPR Erasure of Group & MLS State ===\n');

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
  // Step 1: Provision Alice and Bob
  const alice = await provisionUser('Alice GroupOwner');
  const bob = await provisionUser('Bob Member');
  console.log(`✓ Provisioned Alice (${alice.user_id}) and Bob (${bob.user_id})`);

  // Step 2: Create a group channel with Alice and Bob directly in Postgres
  const channelId = crypto.randomUUID();
  const setupSql = `
    INSERT INTO channels (id, channel_type, name, creator_id) VALUES ('${channelId}', 'group', 'Cryptographic Security Team', '${alice.user_id}');
    INSERT INTO channel_members (channel_id, user_id, role) VALUES ('${channelId}', '${alice.user_id}', 'owner');
    INSERT INTO channel_members (channel_id, user_id, role) VALUES ('${channelId}', '${bob.user_id}', 'member');
    INSERT INTO channel_mls_commits (id, channel_id, sender_id, epoch, commit_data)
      VALUES (gen_random_uuid(), '${channelId}', '${alice.user_id}', 1, decode('deadbeefcafe', 'hex'));
  `;
  execSync(`docker exec -i deploy-postgres-1 psql -U genchat -d genchat -c "${setupSql.replace(/\n/g, ' ')}"`);
  console.log(`✓ Created group channel ${channelId} with Alice & Bob and Alice's epoch 1 MLS commit`);

  // Step 3: Verify initial state in Postgres
  const commitCheck1 = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT count(*) FROM channel_mls_commits WHERE channel_id = '${channelId}';"`
  ).toString().trim();
  assert.strictEqual(commitCheck1, '1', 'MLS commit must exist before erasure');

  const memberCheck1 = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT count(*) FROM channel_members WHERE channel_id = '${channelId}';"`
  ).toString().trim();
  assert.strictEqual(memberCheck1, '2', '2 members must exist in group');
  console.log('✓ Verified initial database invariants (1 MLS commit, 2 members)');

  // Step 4: Alice executes GDPR Right-to-Erasure (DELETE /users/me)
  console.log('\nExecuting Alice cascade erasure (DELETE /users/me)...');
  const deleteRes = await fetch(`${AUTH_HTTP_URL}/users/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${alice.access_token}` },
  });
  assert.strictEqual(deleteRes.status, 200, 'Erasure request must succeed');
  const deleteData = await deleteRes.json();
  assert.strictEqual(deleteData.status, 'erased');
  console.log('✓ Alice account erasure completed successfully');

  // Step 5: Verify that Alice is deleted from users and channel_members
  const aliceInUsers = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT count(*) FROM users WHERE id = '${alice.user_id}';"`
  ).toString().trim();
  assert.strictEqual(aliceInUsers, '0', 'Alice must be completely erased from users');

  const aliceInMembers = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT count(*) FROM channel_members WHERE user_id = '${alice.user_id}';"`
  ).toString().trim();
  assert.strictEqual(aliceInMembers, '0', 'Alice must be removed from channel_members');
  console.log('✓ Alice completely purged from users and channel memberships');

  // Step 6: Verify Bob remains in channel_members
  const bobInMembers = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT count(*) FROM channel_members WHERE channel_id = '${channelId}' AND user_id = '${bob.user_id}';"`
  ).toString().trim();
  assert.strictEqual(bobInMembers, '1', 'Bob must remain active in the group channel');
  console.log('✓ Bob remains active in the group channel');

  // Step 7: CRITICAL MLS INVARIANT: Verify Alice\'s epoch commit was NOT deleted
  // In MLS, deleting a member must NOT corrupt or orphan epoch commit logs
  const commitCheck2 = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT count(*) FROM channel_mls_commits WHERE channel_id = '${channelId}' AND epoch = 1;"`
  ).toString().trim();
  assert.strictEqual(commitCheck2, '1', 'MLS commit must be preserved for remaining group members');

  const commitSender = execSync(
    `docker exec -i deploy-postgres-1 psql -U genchat -d genchat -t -c "SELECT sender_id IS NULL FROM channel_mls_commits WHERE channel_id = '${channelId}' AND epoch = 1;"`
  ).toString().trim();
  assert.strictEqual(commitSender, 't', 'sender_id of commit should be SET NULL to satisfy GDPR without breaking epoch chain');
  console.log('✓ MLS Invariant Verified: Commit log preserved with anonymized sender_id (SET NULL)');

  // Step 8: Clean up test channel
  execSync(`docker exec -i deploy-postgres-1 psql -U genchat -d genchat -c "DELETE FROM channels WHERE id = '${channelId}';"`);

  console.log('\n=== ALL GDPR GROUP & MLS ERASURE TESTS PASSED ===\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
