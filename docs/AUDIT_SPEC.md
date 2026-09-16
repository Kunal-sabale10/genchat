# GenChat Cryptographic & Distributed Systems Security Audit Specification

**Document Version:** 1.0.0  
**Target Release:** GenChat v1.0 Production Architecture  
**Classification:** External Audit Mandate / RFP Specification  
**Scope:** Cryptographic Protocols (PQXDH, TreeKEM MLS, Double Ratchet), Identity & Device Management, Zero-Knowledge Storage, and Gateway Resilience  

---

## 1. Executive Summary & Audit Mandate

GenChat is an enterprise-grade, post-quantum end-to-end encrypted (PQ-E2EE) messaging, group collaboration, and voice signaling platform. The system operates on a zero-knowledge trust model where servers act strictly as blind routing relays and ciphertext stores, possessing zero plaintext access to messages, media, voice payloads, or cryptographic key material.

This document establishes the formal **Security Audit Specification and Request for Proposal (RFP)** for commissioning an external, third-party cryptographic and distributed systems audit. Independent security assessment firms are mandated to evaluate the protocol designs, mathematical implementations, key lifecycles, and attack surfaces before production rollout.

---

## 2. System Architecture & Trust Boundaries

```
[ Web / Mobile / Desktop Client ]  <==== TLS 1.3 / E2EE ====>  [ Web / Mobile / Desktop Client ]
              |                                                               |
    WebSocket / Protobuf                                            WebSocket / Protobuf
              |                                                               |
              v                                                               v
    [ Envoy TLS Ingress ]                                           [ Envoy TLS Ingress ]
              |                                                               |
              v                                                               v
   +-------------------------------------------------------------------------------+
   | Distributed Gateway Layer (Pod A, Pod B, Pod C)                               |
   | - Connection Ceiling (10k conns) & Load Shedder (1536MB Heap, 25k Goroutines)  |
   | - Tiered Pre-Auth Rate Limiting & Device Cap Auto-Eviction (evict_oldest)     |
   | - Redis Clustered Presence Directory & Inter-Pod Routing Bus                  |
   +-------------------------------------------------------------------------------+
              |                                           |
              v                                           v
   +----------------------+                     +----------------------+
   | Auth & Device Svc    |                     | Ledger / Storage Svc |
   | - WebAuthn FIDO2     |                     | - ScyllaDB (Messages)|
   | - Prekey Directory   |                     | - Postgres (Metadata)|
   | - Session Revocation |                     | - S3 / MinIO (Blobs) |
   +----------------------+                     +----------------------+
```

### Trust Boundary Invariants
1. **Zero Server Trust for Message Content:** All direct messages, group commits, group messages, and call signaling payloads are encrypted before leaving the client application. Neither gateway pods nor persistence backends possess decryption keys.
2. **Post-Quantum Forward Secrecy:** Intercepted communication streams recorded today must withstand future decryption by cryptographically relevant quantum computers (CRQCs).
3. **Decoupled Identity & Session Tokens:** Session tokens (JWTs) have a strict 15-minute lifetime and are bounded to specific device IDs. Server-side session revocation instantly disconnects compromised sessions.
4. **Resilient Perimeter:** The gateway layer must shed load gracefully under extreme volumetric stress (FD exhaustion, slowloris WebSocket connections, memory spikes) without process crashes or OOM termination.

---

## 3. Cryptographic Primitives Catalog & Implementation Libraries

| Subsystem | Primitives & Standards | Implementation Libraries | Primary Purpose |
| :--- | :--- | :--- | :--- |
| **PQXDH Key Agreement** | ML-KEM-768 (NIST FIPS 203) + X25519 (RFC 7748) | `@noble/post-quantum/ml-kem`, `@noble/curves/ed25519` | Hybrid post-quantum asynchronous 1:1 session initiation |
| **Symmetric Ratchet** | Signal Double Ratchet, HKDF-SHA256 (RFC 5869), AES-256-GCM | `@noble/hashes/hkdf`, `@noble/ciphers/webcrypto` | 1:1 ongoing messaging, forward secrecy, post-compromise security |
| **Group E2EE (MLS)** | TreeKEM (IETF RFC 9420), Ratchet Trees, Parent-Hash | `packages/mls`, `@noble/hashes` | Scalable multi-party group messaging with constant-time rekeying |
| **Device Linking** | Ephemeral X25519 DH, HMAC-SHA256 SAS | `packages/device-linking`, `@noble/curves` | Out-of-band QR/SAS pairing of secondary devices |
| **Zero-Knowledge Backups**| Argon2id (m=64MB, t=3, p=4), AES-256-GCM | `hash-wasm`, WebCrypto AES-GCM | Client-side encrypted cloud backup of ratchet state and private keys |
| **Authentication & Auth** | WebAuthn / Passkeys (FIDO2), ECDSA P-256, HMAC-SHA256 | `@simplewebauthn`, `crypto/hmac` | Phishing-resistant biometric authentication & session signing |

---

## 4. Key Lifecycle & State Transition Specifications

### 4.1. PQXDH 1:1 Session Establishment
1. **Prekey Bundle Registration:**
   - Client publishes to the server:
     - Identity Key: $IK$ (X25519 Public Key)
     - Signed Prekey: $SPK$ (X25519 Public Key, signed by $IK$)
     - One-Time Prekeys: $OPK_1, \dots, OPK_n$ (X25519 Public Keys, consumed on use)
     - Post-Quantum Prekey: $PQPK$ (ML-KEM-768 Encapsulation Key)
2. **Initiation (Alice $\to$ Bob):**
   - Alice fetches Bob's bundle: $(IK_B, SPK_B, OPK_B, PQPK_B)$.
   - Alice verifies Bob's signature on $SPK_B$ using $IK_B$.
   - Alice generates ephemeral classical keypair $(EK_A, ek_A)$ and post-quantum ciphertext $CT_{PQ}$ via `ML-KEM-768.Encapsulate(PQPK_B) \to (SS_{PQ}, CT_{PQ})$.
   - Alice computes classical shared secrets:
     $$DH_1 = \text{X25519}(ek_A, SPK_B)$$
     $$DH_2 = \text{X25519}(ik_A, SPK_B)$$
     $$DH_3 = \text{X25519}(ek_A, OPK_B)$$
   - Alice combines classical and post-quantum secrets via HKDF-SHA256:
     $$SK = \text{HKDF-Extract}(\text{Salt}, DH_1 \parallel DH_2 \parallel DH_3 \parallel SS_{PQ})$$
   - Alice initializes Double Ratchet state using $SK$.

### 4.2. TreeKEM MLS (RFC 9420) Group Lifecycle
1. **Group Creation:** Group creator establishes a single-node Ratchet Tree with epoch 0.
2. **Member Addition (Welcome Pipeline):**
   - Creator encrypts epoch secret and tree state to new member's KeyPackage via ML-KEM/HPKE.
   - Creator broadcasts `Commit` frame containing MLS proposal and tree leaf index.
3. **Epoch Transition & Tree Rekeying:**
   - On commit, the committer generates an update path secret, hashes upward along direct path to root, generating new epoch keys.
   - Group secret derived: $\text{EpochSecret}_e = \text{HKDF-Expand}(\text{EpochSecret}_{e-1}, \text{CommitSecret})$.
4. **Member Removal & GDPR Erasure:**
   - Removed member's leaf is blanked; committer rekeys root without removed member's keys.
   - Removed member cannot compute $\text{EpochSecret}_{e+1}$, enforcing immediate forward revocation.

### 4.3. Device Pairing & SAS Verification
1. Secondary device displays QR code containing ephemeral public key $PK_{dev2}$ and nonce $N_2$.
2. Primary device scans QR code, generates $PK_{dev1}$ and nonce $N_1$.
3. Both devices compute shared DH secret: $Z = \text{X25519}(sk, pk)$.
4. Both devices derive 6-digit SAS code:
   $$\text{SAS} = \text{HMAC-SHA256}(Z, N_1 \parallel N_2 \parallel PK_{dev1} \parallel PK_{dev2}) \pmod{10^6}$$
5. User confirms identical SAS on both screens before encrypted identity sync begins.

---

## 5. Threat Model & Attacker Capabilities

Auditors must evaluate the system under the following distinct adversary models:

| Adversary Level | Capabilities | Objective |
| :--- | :--- | :--- |
| **Adv-1: Honest-but-Curious Server** | Full access to database, memory, and logs on all servers; observes all ciphertexts, prekey bundles, and metadata. | Attempt to decrypt message bodies, recover identity keys, or reconstruct conversation threads. |
| **Adv-2: Malicious Active Server / Cloud Compromise** | Server intercepts, injects, reorders, or drops WebSocket messages; tampers with prekey bundles; fakes MLS proposals; attempts to insert ghost devices into accounts. | Attempt to execute undetected Man-in-the-Middle (MitM) attacks, fork MLS ratchet trees, or eavesdrop on new group messages. |
| **Adv-3: Network Adversary / MitM** | Compromised intermediate routers, DNS spoofing, rogue Wi-Fi access points, revoked TLS certificates. | Attempt TLS stripping, WebSocket frame injection, handshake tampering, or replay attacks. |
| **Adv-4: Compromised / Lost Device** | Adversary obtains physical or forensic access to a registered user device. | Attempt to extract cloud backups, escalate to other linked devices, or maintain indefinite persistence after remote revocation. |
| **Adv-5: Post-Quantum "Harvest Now, Decrypt Later" (HNDL)** | Adversary records all network traffic indefinitely and uses a future quantum computer running Shor's algorithm. | Attempt to recover classical Diffie-Hellman secrets to compromise past conversation confidentiality. |

---

## 6. Formal Audit Scope: In-Scope vs. Out-of-Scope

### 6.1. In-Scope Components
- **`packages/crypto/`**:
  - PQXDH hybrid key exchange (`pqxdh.ts`, `mlkem.ts`, `x25519.ts`).
  - Double Ratchet implementation (`ratchet.ts`, `kdf.ts`, `session.ts`).
  - Key derivation functions and nonces.
- **`packages/mls/`**:
  - TreeKEM implementation, ratchet tree serialization, parent-hash validations.
  - MLS commit/proposal processing, epoch management, group member transitions.
- **`packages/backup/`**:
  - Argon2id key derivation, salt generation, and envelope encryption.
  - Ephemeral backup keys, recovery flows, and tamper detection.
- **`packages/device-linking/`**:
  - DH handshake, SAS derivation, QR protocol, authenticated key transfer.
- **`services/gateway/`**:
  - WebSocket upgrade security, JWT claims parsing, pre-auth IP rate limiting.
  - Connection ceiling enforcement (503 + Retry-After), memory load shedding circuit breaker.
  - Device cap enforcement (`evict_oldest` policy vs `reject_new`).
  - Redis presence directory and inter-pod message routing.
- **`services/auth/`**:
  - Session lifecycle, 15-minute access token expiry, 30-day single-use rotating refresh tokens.
  - Remote session revocation API (`DELETE /api/v1/sessions/:id`).

### 6.2. Out-of-Scope Components
- Cloud provider hypervisor security (AWS / GCP / Bare Metal hypervisors).
- Operating system level kernel vulnerabilities on developer workstations.
- Physical device side-channel attacks (electromagnetic analysis, microscopic probing).

---

## 7. Known Accepted Risks & Architectural Decisions

1. **Push Notification Privacy Trade-off:** Push notifications dispatched to APNs/FCM contain minimal metadata (Channel ID, Sequence Number, Timestamp) and **no plaintext content**. Message decryption occurs strictly upon client socket reconnection.
2. **Single-Pod In-Memory Buffers:** In-flight WebSocket frame queues are memory-buffered. Pod abrupt termination requires clients to reconcile sequence gaps via ScyllaDB ledger upon reconnect.
3. **Device Cap Ceiling (5 Devices):** Capped at 5 concurrent devices per account. Exceeding 5 devices triggers `DEVICE_CAP_POLICY=evict_oldest`, sending a `session_evicted` frame and disconnecting the oldest socket.

---

## 8. Specific Attack Trees for Auditor Probing

### Attack Tree 1: PQXDH Post-Quantum Downgrade & Replay
```
[ Attacker: Eavesdrop / Inject ]
       |
       +---> Goal 1.1: Force fallback from ML-KEM-768 to classical X25519
       |     - Strip PQPK from prekey bundle during fetch
       |     - Check: Does client reject bundle if post-quantum flag is mandated?
       |
       +---> Goal 1.2: Replay ML-KEM-768 Ciphertext
       |     - Re-send stale post-quantum ciphertext in new session init
       |     - Check: Does combination with fresh ephemeral classical DH prevent session key collision?
       |
       +---> Goal 1.3: Malleability of Kyber Decapsulation
             - Inject corrupted ciphertext into decapsulation routine
             - Check: Does ML-KEM constant-time implicit rejection prevent plaintext oracle leak?
```

### Attack Tree 2: TreeKEM MLS Group Desync & Ghost Member Injection
```
[ Attacker: Compromised Gateway / Server ]
       |
       +---> Goal 2.1: Inject Ghost Member into Ratchet Tree
       |     - Fabricate a Commit frame adding an attacker leaf without creator credentials
       |     - Check: Do clients reject commits with invalid signatures / mismatched parent hashes?
       |
       +---> Goal 2.2: Epoch Fork Attack
       |     - Deliver different Commit frames to distinct partitions of group members
       |     - Check: Does epoch sequence collision or state verification halt communication until resolved?
       |
       +---> Goal 2.3: Post-Removal Eavesdropping
             - Verify removed member cannot decrypt future epochs after commit is processed.
```

### Attack Tree 3: Device Linking & Pairing Hijack
```
[ Attacker: Rogue Device / In-Transit Interceptor ]
       |
       +---> Goal 3.1: SAS Collision Attack
       |     - Search for ephemeral public key producing identical 6-digit decimal SAS code
       |     - Check: Does 30-second handshake expiration make offline preimage search impossible?
       |
       +---> Goal 3.2: Replay Scanned QR Token
             - Attempt to complete handshake using captured QR payload after 60 seconds
             - Check: Does server/client reject replayed nonces?
```

### Attack Tree 4: Zero-Knowledge Cloud Backup Brute-Force
```
[ Attacker: Stolen Database Dump ]
       |
       +---> Goal 4.1: Offline Dictionary Attack against Backup PIN
       |     - Execute GPU/ASIC hash search against Argon2id backup headers
       |     - Check: Are Argon2id parameters (m=64MB, t=3, p=4) sufficient to deter GPU clustering?
       |
       +---> Goal 4.2: Backup Ciphertext Tampering
             - Flip bits in ciphertext or alter metadata payload
             - Check: Does AES-256-GCM authentication tag fail closed with zero plaintext leakage?
```

### Attack Tree 5: Gateway DOS, Connection Starvation, & Pre-Auth Flooding
```
[ Attacker: Distributed Botnet ]
       |
       +---> Goal 5.1: File Descriptor / Goroutine Exhaustion
       |     - Open 20,000 slow WebSocket connections without sending data
       |     - Check: Does gateway trip 10,000 connection ceiling and return HTTP 503 + Retry-After?
       |
       +---> Goal 5.2: Memory OOM Crash
       |     - Flood gateway to inflate heap usage past 1536MB
       |     - Check: Does load shedder trip and reject new handshakes before Linux OOM killer trips at 2Gi?
       |
       +---> Goal 5.3: Pre-Auth Handshake Flooding
             - Burst 500 WebSocket upgrades per second from single IP
             - Check: Does PreAuthLimiter return HTTP 429 Too Many Requests?
```

---

## 9. Automated Verification Manifest

Auditors can execute the complete automated test suite (39 integration and stress suites) using the following commands:

### 9.1. Gateway Resilience & Connection Ceiling Suite
```bash
# Verify 503 connection ceiling, device cap auto-eviction, and Prometheus metrics
node tests/load/test_connection_ceiling_and_rejection.mjs

# Verify high-throughput fanout and 100% ACK delivery
node tests/integration/test_group_load_fanout.mjs
```

### 9.2. Multi-Device, MLS, & Key Lifecycle Suites
```bash
# Multi-device synchronization & cross-device ratchet updates
node tests/integration/test_multi_device_sync.mjs

# TreeKEM MLS dynamic rekeying & epoch transitions
node tests/integration/test_mls_group_chat.mjs
node tests/integration/test_mls_dynamic_and_ai.mjs

# GDPR group member erasure & forward revocation
node tests/integration/test_gdpr_group_mls_erasure.mjs
```

### 9.3. Device Pairing & Backup Security Penetration Tests
```bash
# Penetration test on device linking SAS exchange
node tests/security/test_device_linking_pentest.mjs

# Penetration test on Argon2id backup encryption & PIN hardening
node tests/security/test_backup_pin_security.mjs
```

### 9.4. Active Session Management & Cross-Pod Routing
```bash
# Session listing, token expiry, and remote revocation
node tests/integration/test_session_management.mjs

# Multi-instance gateway presence and Redis pub/sub delivery
node tests/integration/test_cross_pod_routing.mjs
```

---

## 10. Audit Deliverables & Acceptance Criteria

External auditors must provide:
1. **Executive Summary Report:** Overall security posture rating, critical risk register.
2. **Detailed Technical Findings:** CVSS v3.1 scoring, reproducible proof-of-concept (PoC) scripts for every identified vulnerability.
3. **Remediation Recommendations:** Code-level patches and architectural design adjustments.
4. **Re-Testing Certification:** Formal sign-off upon verification of vendor remediations.
