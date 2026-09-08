# GenChat Group Chat Architecture & MLS Rollout Plan

**Document Version**: 1.0.0  
**Classification**: System Architecture Specification  
**Status**: Roadmap & Implementation Specification (Phase 2)  
**Target Standard**: RFC 9420 (Messaging Layer Security - MLS) + TreeKEM  

---

## 1. Executive Summary

GenChat's initial production release (Phase 1) delivers post-quantum authenticated end-to-end encryption for pairwise (1:1) conversations using **PQXDH** (ML-KEM-768 + X25519) and **Double Ratchet**, alongside SFrame WebRTC media calls and zero-knowledge presigned S3 media storage.

This document formalizes the architectural roadmap for **Phase 2: Group Chat Rollout**, leveraging the pre-implemented MLS TreeKEM engine in the Rust cryptographic core (`crypto/genchat-crypto/src/mls.rs`) and migrating the dormant `proto/experimental/channels.proto.archived` into active production services.

---

## 2. Current State Audit

| Layer | Current Status | Assets Present |
|:---|:---|:---|
| **Cryptographic Core** | **Complete & Verified** | `crypto/genchat-crypto/src/mls.rs` implements RFC 9420 TreeKEM epoch ratchet, key package generation, welcome messages, commit operations, and tree updates. Tested in `tests/mls_test.rs`. |
| **API Contract** | **Scaffolded (Archived)** | `proto/experimental/channels.proto.archived` defines `ChannelService`, `Channel`, `ChannelMember`, `CreateChannel`, `JoinChannel`, and `LeaveChannel`. Generated Go stubs exist in `gen/chat/v1/channels.pb.go`. |
| **Relational Metadata**| **Migrated (Dormant)** | `schema/postgres/migrations/005_channels.up.sql` defines `channels` and `channel_members` with roles (`OWNER`, `ADMIN`, `MEMBER`). |
| **Distributed Ledger** | **Migrated (Dormant)** | `schema/scylla/002_channels.cql` defines channel message storage with TimeWindowCompactionStrategy. |
| **Gateway Routing** | **1:1 Pairwise Only** | `services/gateway/internal/relay/router.go` handles DM routing and offline push; broadcast `chan_` paths exist as stubs. |
| **Web Client UI** | **1:1 Direct Chat Only** | `packages/client-web` renders pairwise chats; group creation and member management UI is intentionally dormant. |

---

## 3. Architectural Design for MLS Group Messaging

```
 ┌────────────────┐              ┌────────────────┐
 │  Alice (Admin) │              │   Bob (Member) │
 └───────┬────────┘              └────────┬───────┘
         │                                │
         │ 1. CreateChannel Request       │
         │    (MLS Welcome + TreeKEM)     │
         ▼                                │
 ┌────────────────────────────────────────┴───────┐
 │               Gateway & Channelsd              │
 │  - Validates JWT & Channel Membership Roles    │
 │  - Stores Channel Entity in PostgreSQL         │
 │  - Distributes MLS Welcome to Bob's Queue      │
 │  - Persists Commit Frame in ScyllaDB Ledger    │
 └───────────────────────┬────────────────────────┘
                         │
                         │ 2. Distribute MLS Welcome / Commit
                         ▼
                 ┌────────────────┐
                 │   Bob Device   │ (Initializes MlsGroup from Welcome)
                 └────────────────┘
```

### 3.1 MLS TreeKEM Invariants
1. **Asymptotic Efficiency**: In a group of size $N$, group key updates and member additions/removals scale at $O(\log N)$ computational and bandwidth overhead rather than $O(N)$ pairwise ratchet sessions.
2. **Post-Compromise Security (PCS)**: When a member initiates a TreeKEM commit, new ephemeral path secrets are generated from the member's leaf to the root. Once processed, previous compromised states cannot decrypt subsequent epoch messages.
3. **Epoch Transition Ordering**: Group messages and commits are strictly sequenced by ScyllaDB sequence numbers. State divergence is prevented by requiring clients to apply epoch commits synchronously before encrypting new application messages.

---

## 4. Phase 2 Rollout Milestones

### Milestone 1: Wire Contract & Code Generation
- Promote `proto/experimental/channels.proto.archived` to `proto/chat/v1/channels.proto`.
- Extend `ChannelService` with:
  - `PublishKeyPackages(PublishKeyPackagesRequest) returns (PublishKeyPackagesResponse)` (allowing users to publish pre-generated MLS KeyPackages to `authd`).
  - `GetGroupEpoch(GetGroupEpochRequest) returns (GetGroupEpochResponse)` (retrieving current epoch number and tree hash).
- Recompile Protobuf bindings for Go and TypeScript.

### Milestone 2: Service Layer Implementation
- **Option Selected**: Integrate `ChannelService` into `services/gateway` as a dedicated sub-handler or run a lightweight `channelsd` daemon.
- Implement PostgreSQL store repository matching `005_channels.up.sql`:
  - `CreateChannel(name, creator_id, initial_members)`.
  - `AddChannelMembers(channel_id, members)`.
  - `RemoveChannelMember(channel_id, user_id)`.
  - `ListUserChannels(user_id)`.

### Milestone 3: Gateway Fanout & Commit Routing
- Update `services/gateway/internal/relay/router.go`:
  - On incoming `send_message` targeting `chan_<uuid>`:
    - Verify sender is an active member in Redis/Postgres channel cache.
    - Persist group ciphertext in ScyllaDB `channels` partition.
    - Fan out push frame to all online channel members.
    - Query offline members via `PushServiceClient` and dispatch silent background wake-up notifications.

### Milestone 4: Client Cryptographic Runtime (WASM / TypeScript)
- Wrap `crypto/genchat-crypto/src/mls.rs` in `crypto/genchat-crypto-ffi`:
  - `mls_group_create(creator_identity, key_packages)`
  - `mls_group_process_commit(group_state, commit_bytes)`
  - `mls_group_encrypt(group_state, plaintext)`
  - `mls_group_decrypt(group_state, ciphertext)`
- Compile to WebAssembly for `packages/client-crypto`.
- Update `packages/client-db` RxDB schema:
  - Add `channels` and `mls_epoch_states` collections.

### Milestone 5: Frontend UI & Verification
- Add "New Group Chat" modal in `packages/client-web/src/pages/ChatPage.tsx`.
- Support group participant list, admin badges, and leave group options.
- Automated E2E integration test: `tests/integration/test_group_chat_mls.mjs` verifying multi-client group creation, MLS key package consumption, epoch turnover, and history synchronization.

---

## 5. Security & Risk Analysis

| Risk | Impact | Planned Mitigation |
|:---|:---|:---|
| **Stale KeyPackages** | User cannot be added to group | Clients maintain a pool of 20 active MLS KeyPackages in `authd` and replenish upon consumption. |
| **Concurrent Commits** | Two members commit simultaneously | ScyllaDB CAS / sequential numbering rejects the second commit; losing client fetches the winner's commit and re-proposes. |
| **Large Group Fanout** | Gateway CPU spike during broadcast | Gateway utilizes epoll/WebSocket connection pool worker groups with bounded concurrency. |
