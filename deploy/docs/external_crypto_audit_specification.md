# GenChat External Cryptographic & Architecture Security Audit Specification

**Document Version**: 1.0.0  
**Target Milestone**: GenChat Enterprise Production Readiness  
**Target Reviewers**: Tier-1 Cryptographic Security Auditors (e.g., Trail of Bits, NCC Group, Kudelski Security, Quarkslab)  
**Repository**: [https://github.com/Kunal-sabale10/genchat.git](https://github.com/Kunal-sabale10/genchat.git)  

---

## 1. Engagement Overview & Objectives

GenChat has implemented a next-generation, post-quantum end-to-end encrypted (E2EE) messaging, group collaboration, and media calling platform. All core cryptographic mechanisms, microservice authorizations, supply chains, and persistence pipelines have been consolidated into production code.

This document serves as the formal **Audit Specification & Terms of Reference** for an external cryptographic and architecture security assessment.

### Primary Objectives:
1. **Mathematical & Cryptographic Soundness**: Validate the protocol construction and Rust implementation of hybrid Post-Quantum Extended Diffie-Hellman (PQXDH) with ML-KEM-768 and X25519.
2. **IETF Standard Compliance**: Verify conformance of MLS group messaging with **RFC 9420** and WebRTC media encryption with **RFC 9605 (SFrame)**.
3. **Zero-Knowledge State Isolation**: Confirm that the untrusted server infrastructure (Auth, Gateway, Message Ledger, Media proxy) cannot derive session keys, decrypt payloads, or compromise forward secrecy.
4. **Implementation Vulnerabilities**: Audit Rust FFI memory safety, WebAssembly bindings, Go microservice authorization fail-closed logic, and client-side TypeScript key handling.

---

## 2. In-Scope Components & Source Code Boundaries

| Component | Language / Framework | Primary Source Paths | Primary Cryptographic Primitives |
| :--- | :--- | :--- | :--- |
| **Core Crypto Engine** | Rust (`no_std` compatible) | `crypto/genchat-crypto/src/` | ML-KEM-768, X25519, Ed25519, HKDF-SHA256, AES-256-GCM |
| **Crypto FFI & WASM** | Rust / C FFI / `wasm-bindgen` | `crypto/genchat-crypto-ffi/` | C ABI exports, zeroization on drop, memory safety |
| **1:1 E2EE Ratchet** | TypeScript / WebCrypto / WASM | `packages/client-web/src/lib/e2ee-ratchet.ts` | PQXDH handshake negotiation, prekey replenishment, Double Ratchet |
| **Group Chat MLS** | TypeScript / WASM | `packages/client-web/src/lib/mls-group-manager.ts` | RFC 9420 TreeKEM, epoch secret derivation, Commit/Welcome parsing |
| **WebRTC Media SFrame** | TypeScript / WebRTC Encoded Transforms | `packages/client-web/src/lib/group-webrtc-manager.ts` | RFC 9605 SFrame, MLS epoch key exporter binding, frame counter sync |
| **Key Backup & Recovery** | TypeScript / Go | `packages/client-web/src/lib/key-backup.ts`, `services/auth` | PBKDF2-SHA256 (600,000 iterations), AES-256-GCM, zero-knowledge wrapping |
| **Multi-Device Pairing** | TypeScript / Go | `packages/client-web/src/lib/device-linking.ts`, `services/auth` | NIST P-256 ECDH, SHA-256 6-digit confirmation code verification, replay mitigation |
| **Gateway Routing Relay** | Go 1.24 | `services/gateway/internal/relay/` | Fail-closed authorship, W3C tracing, blocklist enforcement |
| **Message Ledger** | Go 1.24 / ScyllaDB | `services/msgledger/` | Idempotent deduplication, monotonic sequencing, ScyllaDB TimeWindow TTL |

---

## 3. Threat Model & Security Invariants

The assessment must evaluate the system against the following formal threat models:

### 3.1 Untrusted Server & Compromised Infrastructure Model
- **Assumption**: An active adversary fully controls the Go microservices (Auth, Gateway, Ledger, Media), PostgreSQL, and ScyllaDB, with ability to observe, drop, delay, replay, or inject arbitrary packets.
- **Invariant 1.1**: The adversary must be computationally incapable of decrypting any 1:1 message, group message, voice note, or media stream.
- **Invariant 1.2**: The adversary cannot forge a valid message envelope without possessing the sender's private Ed25519 identity key.
- **Invariant 1.3**: The adversary cannot tamper with an MLS epoch or substitute group member keys without causing immediate signature verification failure.

### 3.2 Quantum Adversary ("Store Now, Decrypt Later")
- **Assumption**: An adversary records all network traffic today and obtains a cryptographically relevant quantum computer (CRQC) in the future.
- **Invariant 2.1**: Because session keys are encapsulated using hybrid **ML-KEM-768 + X25519**, quantum computers capable of solving discrete logarithms cannot recover historical session keys or plaintexts.

### 3.3 Post-Compromise Security (PCS) & Forward Secrecy (FS)
- **Invariant 3.1**: Compromise of an ephemeral session key does not compromise past messages (Forward Secrecy).
- **Invariant 3.2**: After an ephemeral key compromise, subsequent ratchet steps or MLS epoch commits heal the session, restoring complete confidentiality (Post-Compromise Security).

### 3.4 Key Backup Zero-Knowledge
- **Invariant 4.1**: The server stores only opaque `BYTEA` ciphertext. Without the user's master passphrase, the server or any database intruder cannot extract identity seeds or private keys.
- **Invariant 4.2**: Server-side rate limiting prevents automated dictionary attacks against low-entropy passphrases.

### 3.5 Device-Linking Mutual Authentication
- **Invariant 5.1**: Session hijacking is prevented by requiring mutual verification of an out-of-band 6-digit confirmation code (`auth_code_hash`) before the primary device uploads re-encrypted identity state.
- **Invariant 5.2**: Replay attacks are prevented through atomic single-use session consumption.

---

## 4. Audit Testing Harnesses & Reproduction Guide

Auditors can execute the entire verification test suite locally using the following automated tools:

### 4.1 Rust Cryptographic Unit & Adversarial Tests
```bash
cd crypto/genchat-crypto
cargo test --verbose
```
*Coverage: Handshake validity, TreeKEM evolution, SFrame payload tampering, adversarial ciphertext bit-flipping, memory zeroization on drop.*

### 4.2 Backend Unit & Table-Driven Tests
```bash
go test -v ./services/auth/...
go test -v ./services/gateway/...
go test -v ./services/media/...
go test -v ./services/msgledger/...
```

### 4.3 End-to-End Live Cryptographic Integration Tests
```bash
# Boot the live Docker environment
docker compose -f deploy/docker-compose.yaml up -d

# Execute cryptographic integration test suite
node tests/integration/test_true_e2ee.mjs
node tests/integration/test_key_backup.mjs
node tests/integration/test_device_linking.mjs
node tests/security/test_device_linking_pentest.mjs
node tests/security/test_backup_pin_security.mjs
node tests/integration/test_gdpr_group_mls_erasure.mjs
node tests/integration/test_disaster_recovery.mjs
```

---

## 5. Audit Deliverables & Timeline

The auditing firm will provide:
1. **Executive Summary & Risk Scoring**: Standard CVSS v3.1 / DREAD vulnerability scoring.
2. **Detailed Finding Reports**: Root cause, reproduction PoC, cryptographic impact, and remediation recommendations.
3. **Formal Verification of Fixes**: Re-test of patched commits before public release.
4. **Public Audit Certificate & Report**: Redacted public-facing audit summary for enterprise compliance (SOC2 / ISO 27001).
