# GenChat Enterprise Disaster Recovery (DR) & State Resilience Runbook

This document defines the Disaster Recovery (DR) architecture, Recovery Point Objective (RPO), Recovery Time Objective (RTO) Service Level Objectives (SLOs), backup/restore procedures, and cryptographic state resilience proofs for the GenChat enterprise platform.

---

## 1. Executive Summary & SLO Commitments

GenChat decouples ephemeral transport routing, immutable message storage, identity authentication, and end-to-end cryptographic state into resilient tiers.

| Tier | Component | Data Managed | RPO Target | RTO Target | Primary Resilience Mechanism |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Identity & Key Auth** | PostgreSQL 17 | Users, WebAuthn passkeys, PQXDH prekeys, device linking, user blocks, encrypted key backups | **< 5 min** | **< 15 min** | WAL streaming / continuous archiving, hourly snapshots, automated failover |
| **Tier 2: Message Ledger** | ScyllaDB 6.2 | E2EE message envelopes, MLS channel messages, commit logs, deduplication tables | **< 15 min** | **< 20 min** | Distributed quorum (`LOCAL_QUORUM`), hourly `nodetool snapshot`, commitlog sync |
| **Tier 3: Sequence & Caching** | Redis 7 | Conversation monotonic sequence counters, presence, tiered rate-limit tokens | **< 1 sec** | **< 2 min** | Append-Only File (`AOF`) with `appendfsync everysec`, in-memory fallback |
| **Tier 4: Client Cryptographic State** | Browser / Native Device | PQXDH session ratchets, MLS group state, identity private keys | **0 s (Zero-Loss)** | **Instant** | Local persistent IndexedDB storage, cross-device pairing, zero-knowledge cloud backup |

**Global SLA Commitments**:
- **Recovery Point Objective (RPO)**: Strict **< 1 hour** (target: < 5 minutes for transactional data).
- **Recovery Time Objective (RTO)**: Strict **< 30 minutes** (target: < 10 minutes for full platform cold start).

---

## 2. Cryptographic State Resilience: Proof of Ratchet Desync Immunity

A critical design consideration in distributed messaging architectures is whether the failure, restart, or sequence reset of an ephemeral ledger counter (such as Redis `seq:<conversation_id>`) can cause client-side cryptographic ratchets to desynchronize or fail decryption.

### 2.1 The Invariance Principle
**Theorem**: GenChat clients **never** experience ratchet desynchronization or decryption failure as a result of transport sequence resets, sequence regressions, or Redis sequence counter destruction.

### 2.2 Formal Proof for 1:1 PQXDH (Double Ratchet)
1. **Key Derivation Independence**: In `packages/client-web/src/lib/e2ee-ratchet.ts`, message payload encryption is performed using AES-256-GCM under a symmetric key $K_{session}$ derived from the Post-Quantum Extended Diffie-Hellman (PQXDH) shared secret:
   $$K_{session} = \text{HKDF}(\text{IKM} = S_{PQXDH}, \text{salt} = \text{"genchat_pqxdh_salt"}, \text{info} = \text{"session_" } \parallel \text{conversation\_id})$$
2. **Ratchet Step Encapsulation**: Each message carries its own unique 96-bit initialization vector (`ivHex` generated via `crypto.getRandomValues`) and client-side ratchet headers (`initMessage`, `senderFingerprint`).
3. **Decoupled Transport Sequence**: The `sequenceNum` assigned by `msgledger` (via Redis `INCR seq:<conv_id>`) is strictly an envelope metadata field intended for UI timeline rendering and delta pagination. It is **not** included in the AES-GCM Associated Data (AAD), nor does it feed into the KDF chain.
4. **Conclusion**: If Redis sequence key `seq:<conv>` resets from 1,000 back to 1:
   - The recipient's cryptographic engine receives the envelope with its independent `ivHex` and session key $K_{session}$.
   - AES-256-GCM decrypts the ciphertext cleanly without error.
   - Zero cryptographic ratchet desynchronization occurs.

### 2.3 Formal Proof for MLS Group Messaging (RFC 9420)
1. **Epoch & Secret Tree Isolation**: MLS channel messages in `schema/scylla/001_messages.cql` contain:
   - `epoch`: The MLS group epoch identifier.
   - `commit_id`: The cryptographic transition commit.
   - `encrypted_payload`: The MLS application ciphertext.
2. **Ratchet Tree Progression**: State advancement is dictated exclusively by signed MLS `Commit` proposals processed sequentially across the group's ratcheting tree.
3. **Transport Independence**: The ledger sequence counter has zero bearing on the MLS state machine; epoch progression is validated through cryptographic signatures of group members.

---

## 3. Data Tier Backup & Snapshot Procedures

### 3.1 PostgreSQL (Identity & Zero-Knowledge Key Backups)

#### Automated Continuous WAL Archiving & Daily Dumps:
```bash
# 1. Trigger automated full database backup
docker exec -t deploy-postgres-1 pg_dump -U genchat -F c -b -v -f /var/lib/postgresql/data/genchat_backup_$(date +%Y%m%d_%H%M%S).dump genchat

# 2. Archive WAL segments to off-site object storage (S3 / GCS / MinIO)
# Configured in postgresql.conf:
# archive_mode = on
# archive_command = 'test ! -f /mnt/wal_archive/%f && cp %p /mnt/wal_archive/%f'
```

#### Point-In-Time Restore (PITR) Runbook:
```bash
# 1. Stop auth service
docker compose -f deploy/docker-compose.yaml stop auth

# 2. Restore base dump
docker exec -t deploy-postgres-1 pg_restore -U genchat -d genchat --clean --if-exists /var/lib/postgresql/data/genchat_backup_TARGET.dump

# 3. Replay WAL segments up to target timestamp
# Specify target recovery time in recovery.signal: recovery_target_time = '2026-09-15 00:00:00 UTC'

# 4. Restart auth service
docker compose -f deploy/docker-compose.yaml start auth
```

---

### 3.2 ScyllaDB (Message Ledger & MLS Commit Logs)

#### Hourly Snapshot Creation:
```bash
# 1. Flush memtables to SSTables
docker exec -t deploy-scylladb-1 nodetool flush genchat

# 2. Generate point-in-time snapshot across all nodes
SNAPSHOT_NAME="snapshot_$(date +%Y%m%d_%H%M%S)"
docker exec -t deploy-scylladb-1 nodetool snapshot -t $SNAPSHOT_NAME genchat

# 3. Synchronize snapshot directories to off-cluster persistent storage
# Path: /var/lib/scylla/data/genchat/*/snapshots/$SNAPSHOT_NAME/
```

#### Cluster Snapshot Restore Runbook:
```bash
# 1. Truncate target tables or re-create keyspace
docker exec -i deploy-scylladb-1 cqlsh -e "TRUNCATE genchat.messages; TRUNCATE genchat.channel_messages; TRUNCATE genchat.client_dedup; TRUNCATE genchat.mls_commit_log;"

# 2. Copy snapshot SSTables back to table data directories
# /var/lib/scylla/data/genchat/<table_uuid>/

# 3. Refresh tables into active ScyllaDB memory
docker exec -t deploy-scylladb-1 nodetool refresh genchat messages
docker exec -t deploy-scylladb-1 nodetool refresh genchat channel_messages
docker exec -t deploy-scylladb-1 nodetool refresh genchat mls_commit_log

# 4. Run repair to reconcile inter-node consistency
docker exec -t deploy-scylladb-1 nodetool repair genchat
```

---

### 3.3 Redis (Monotonic Sequence Counter & Token Buckets)

#### Durability Configuration:
Redis is configured with AOF (`Append-Only File`) enabled and synchronized every second (`appendfsync everysec`):
```yaml
redis:
  image: redis:7-alpine
  command: redis-server --appendonly yes --appendfsync everysec --maxmemory 256mb
  volumes:
    - redisdata:/data
```

#### Sequence Recovery in the Event of Unscheduled Redis Wipe:
If Redis volume data is lost completely during a cold-start disaster:
1. Redis restarts cleanly with empty memory.
2. When the first subsequent message for `conversation_id` is processed by `msgledger`, `g.client.Incr(ctx, key)` initializes the key at `1`.
3. Because ScyllaDB primary keys are keyed on `((conversation_id, bucket), message_id TIMEUUID)`, message storage is completely collision-free.
4. Client E2EE ratchets decrypt all messages seamlessly as demonstrated in Section 2 and Section 5.
5. To re-seed sequence numbers to match or exceed historical ScyllaDB sequences, the following reconciliation script can be run against ScyllaDB:
   ```bash
   # Query max sequence per active conversation from ScyllaDB and SET in Redis
   node scripts/dr/reseed_redis_sequences.mjs
   ```

---

## 4. End-to-End Cold Start Recovery Runbook

When orchestrating a full cold-start recovery (e.g., following complete data center failure):

```bash
# Step 1: Initialize Core Infrastructure & Persistent Networks
docker compose -f deploy/docker-compose.yaml up -d postgres scylladb redis

# Step 2: Await Healthchecks
docker compose -f deploy/docker-compose.yaml ps

# Step 3: Run Database Migrations
docker compose -f deploy/docker-compose.yaml up scylla-init

# Step 4: Verify/Restore PostgreSQL Base State
docker exec -i deploy-postgres-1 psql -U genchat -d genchat -c "SELECT count(*) FROM users;"

# Step 5: Start Microservices (Auth, Gateway, Ledger, Media)
docker compose -f deploy/docker-compose.yaml up -d auth ledger gateway media

# Step 6: Verify Distributed Trace & Health Endpoints
curl -f http://localhost:8080/healthz
curl -f http://localhost:8081/healthz
curl -f http://localhost:8081/metrics

# Step 7: Launch Frontend Application
docker compose -f deploy/docker-compose.yaml up -d web
```

---

## 5. Automated Verification & Resilience Test

To execute the automated disaster recovery simulation verifying sequence monotonicity and ratchet desynchronization immunity:

```bash
node tests/integration/test_disaster_recovery.mjs
```

**Verified Test Assertions**:
- `✓ PQXDH Handshake negotiation succeeds`
- `✓ Pre-disaster messages encrypted and decrypted cleanly`
- `✓ Simulated Redis sequence counter wipe executes`
- `✓ Post-disaster messages with reset sequence counters decrypt cleanly`
- `✓ Zero ratchet desync or corrupted plaintexts detected`
