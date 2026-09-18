# GenChat Formal STRIDE Threat Model & Cryptographic Attack Surface

Version: 1.0.0  
Classification: Internal Security Architecture  
Target Cryptographic Standards: RFC 9420 (MLS), NIST Post-Quantum Kyber-1024, RFC 7519 (JWT), RFC 6455 (WebSockets)  

---

## 1. System Overview & Trust Boundaries

GenChat establishes an end-to-end encrypted messaging architecture where application servers (Edge Gateway, Message Ledger, Auth Service, and Object Storage) are treated as **zero-knowledge untrusted relays**. 

```
[ Client A (Trusted) ] === TLS 1.3 ===> [ Edge Gateway (Untrusted Relay) ]
         |                                           |
         | (End-to-End Encrypted Payload)            |-- ScyllaDB (Encrypted Ledger)
         v                                           |-- Redis (Ephemeral Presence)
[ Client B (Trusted) ] <=== TLS 1.3 === [ Edge Gateway (Untrusted Relay) ]
```

### Trust Zones
1. **Zone 1: Client Hardware / Secure Enclave** (Fully Trusted): Hosts identity private keys, Kyber decapsulation keys, and MLS tree states.
2. **Zone 2: Transport Layer** (Cryptographically Protected): Authenticated TLS 1.3 with forward secrecy.
3. **Zone 3: Edge Infrastructure & Gateway** (Semi-Trusted): Verifies JWT signatures, performs rate limiting, routes envelopes without access to plaintext payloads.
4. **Zone 4: Persistent Storage & Databases** (Untrusted with respect to content): Stores blinded ciphertexts, cryptographic prekeys, and salted password hashes.

---

## 2. STRIDE Threat Analysis

### 2.1 Spoofing (Identity & Authenticity)

| Threat ID | Threat Description | Attack Vector | Mitigation Control | Residual Risk |
|---|---|---|---|---|
| **S-01** | User Impersonation via Stolen Token | Adversary captures JWT access token via network or client breach | Short token TTL (15m), rotating refresh tokens with server-side revocation list in Redis | Vulnerability window limited to 15m; immediate token revocation on logout |
| **S-02** | Rogue Gateway Pod Impersonation | Malicious actor attempts to join Redis cluster presence directory | mTLS inter-service authentication and Redis ACLs with password rotation | Low (Requires cluster network intrusion) |
| **S-03** | Sender Forgery in E2EE Direct Message | Relay alters `sender_id` to forge origin of ciphertext | Double Ratchet / PQXDH ephemeral key signatures verified directly by recipient client | Zero (Forged sender cannot produce valid DH shared secret) |

---

### 2.2 Tampering (Data Integrity)

| Threat ID | Threat Description | Attack Vector | Mitigation Control | Residual Risk |
|---|---|---|---|---|
| **T-01** | Wire Ciphertext Modification | Relay modifies encrypted frame payload in transit | AES-256-GCM / ChaCha20-Poly1305 AEAD authentication tags | Zero (Decryption fails on invalid tag; client rejects message) |
| **T-02** | Pre-Signed S3 URL Parameter Tampering | Adversary alters expiry or target path in MinIO SigV4 URL | Canonical query string signing with SHA-256 HMAC (RFC-correct SigV4) | Zero (Signature verification fails if any query parameter or path is altered) |
| **T-03** | MLS Group State Desynchronization | Relay drops or reorders MLS Commit proposals | Message Ledger sequential Lamport/vector clocks and ScyllaDB monotonic sequences | Zero (Commit epoch mismatch causes client to request synchronization) |

---

### 2.3 Repudiation

| Threat ID | Threat Description | Attack Vector | Mitigation Control | Residual Risk |
|---|---|---|---|---|
| **R-01** | Message Denial by Sender | Sender claims they did not dispatch a specific message | Ed25519 identity key signature embedded in PQXDH handshake prekey bundle | Zero (Cryptographically provable sender attribution) |
| **R-02** | Falsified Read Receipt | Malicious actor fabricates read receipt without opening message | Delivery receipts authenticated with client session token and recipient device ID | Low |

---

### 2.4 Information Disclosure (Confidentiality)

| Threat ID | Threat Description | Attack Vector | Mitigation Control | Residual Risk |
|---|---|---|---|---|
| **I-01** | Harvest Now, Decrypt Later (Quantum Attack) | Passive state actor records ciphertexts for future quantum decryption | Hybrid PQXDH: Combines Classical X25519 ECDH with Post-Quantum ML-KEM / Kyber-1024 | Negligible (Protected against both classical and quantum computing adversaries) |
| **I-02** | Metadata Leakage via Push Notifications | Push notification payloads reveal conversation sender or preview | Zero-payload push notifications: Push alert contains only wakeup trigger; message fetched over WebSocket | Zero message preview disclosure |
| **I-03** | Ephemeral Message Forensics | Expired disappearing messages recovered from device storage | Client deletes encryption ratchet keys upon timer expiry; ciphertext becomes permanently unrecoverable | Low (Requires physical device RAM dump prior to key zeroization) |

---

### 2.5 Denial of Service (Availability)

| Threat ID | Threat Description | Attack Vector | Mitigation Control | Residual Risk |
|---|---|---|---|---|
| **D-01** | Gateway Socket Saturation Attack | Distributed botnet opens thousands of idle WebSocket connections | Per-pod connection ceilings (`MAX_CONNECTIONS_PER_POD`), pre-auth token bucket rate limiting, HTTP 503 load shedding | Low (Protects pod stability, sheds excess traffic) |
| **D-02** | Excessive Device Registration Flood | Adversary registers hundreds of fake devices per account | Hard 5-device account cap with automated least-recently-used session eviction (`session_evicted` frame) | Zero (Bounded memory consumption per user) |
| **D-03** | Media Storage Exhaustion | Client uploads massive multi-gigabyte blobs to MinIO | Strict upload limit (100MB per file), SigV4 Content-Length enforcement, token bucket rate limiter | Zero (Presigned URL generator rejects requests > 100MB) |

---

### 2.6 Elevation of Privilege

| Threat ID | Threat Description | Attack Vector | Mitigation Control | Residual Risk |
|---|---|---|---|---|
| **E-01** | Unauthorized Group Member Promotion | Regular member executes admin commit to add/remove members | MLS Group Ratification rules enforced cryptographically by all group participants | Zero (Unauthorized commit rejected by all participant client ratchets) |
| **E-02** | Cross-Account Backup Restoration | Attacker attempts to restore another user's encrypted backup bundle | Argon2id KDF with user passphrase + bundle HMAC verification | Zero (Decryption fails without correct user master password) |

---

## 3. Cryptographic Primitives Summary

* **Key Agreement**: Kyber-1024 (Post-Quantum) + X25519 (Classical)
* **Symmetric Encryption**: AES-256-GCM / ChaCha20-Poly1305 (256-bit keys)
* **Digital Signatures**: Ed25519
* **Key Derivation**: HKDF-SHA256 (Ratchet) and Argon2id (Backups: $m=64\text{MB}, t=3, p=4$)
* **Group Messaging**: MLS (RFC 9420) with Ratchet Trees
* **Media Calling**: WebRTC with SFrame (RFC 9605) frame encryption
