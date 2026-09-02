# Cryptographic Security Audit & Architecture Verification

**Project**: GenChat Post-Quantum Secure Communication Platform  
**Target Architecture**: PQXDH + Double Ratchet (1:1), MLS TreeKEM (RFC 9420), SFrame E2EE WebRTC (RFC Draft)  
**Classification**: High-Assurance Cryptographic System  

---

## 🛡️ 1. Cryptographic Protocol Invariants

### A. Post-Quantum Forward Secrecy (PQ-FS)
- **Mechanism**: Hybrid key encapsulation using **ML-KEM-768** (NIST FIPS 203) combined with classical **X25519** Diffie-Hellman and Ed25519 authentication.
- **Invariant**: Even if an adversary captures all network traffic and later gains access to a cryptographically relevant quantum computer (CRQC), pre-recorded ciphertext cannot be decrypted because ML-KEM-768 encapsulation is quantum-hard (Module Learning With Errors).

### B. Post-Compromise Security (PCS)
- **Pairwise 1:1**: The Double Ratchet performs a DH ratchet step with every message exchange. A transient compromise of an ephemeral state key is permanently healed after one round-trip message exchange.
- **MLS Group Chats**: Member key updates generate new secret paths along the TreeKEM tree to root ($O(\log N)$), advancing the group epoch secret and restoring security.

### C. Zero-Knowledge Media & WebRTC SFU
- **Media**: AES-256-GCM media keys are generated client-side and transmitted strictly inside E2EE message payloads. MinIO/S3 acts purely as an opaque blob store.
- **Calling**: SFrame transforms encrypt raw video/audio frames at the WebRTC Encoded Transform layer. The SFU routes opaque packets by inspecting unencrypted RTP headers without decryption capabilities.

---

## 🧹 2. Memory Zeroization & Hygiene Audit

All sensitive private key material, root ratchet keys, and decryption buffers implement memory zeroization on drop:

| Data Structure | Crate / Type | Zeroization Assurance |
|:---|:---|:---|
| **Identity Private Key** | `ed25519_dalek::SigningKey` | Zeroized on drop (`zeroize` crate derive) |
| **X25519 Static Secret** | `x25519_dalek::StaticSecret` | Implements `ZeroizeOnDrop` |
| **ML-KEM Decapsulation Key**| `ml_kem::kem::DecapsulationKey` | Zeroized internal hybrid array buffer |
| **MLS Epoch & App Secret** | `MlsGroup.epoch_secret` | Erased and overwritten on epoch transition |
| **SFrame Base Secret** | `SFrameTransformer.base_secret`| Erased on transformer drop |

---

## 🎯 3. Threat Model & Penetration Matrix

| Threat Vector | Adversary Capability | Platform Defense / Mitigation |
|:---|:---|:---|
| **Malicious / Compromised SFU** | Man-in-the-Middle on WebRTC media | SFrame per-frame authenticated encryption (AES-256-GCM); SFU cannot access keys |
| **Compromised Database (Postgres/Scylla)** | Full SQL/CQL read access to stored tables | Zero plaintext stored; only blinded tokens, pre-key public keys, and E2EE ciphertexts |
| **Rogue Push Dispatcher** | Inspects APNs/FCM background notifications | Silent notifications use `content-available: 1` with 0 metadata/plaintext |
| **Replay & Frame Injection** | Replay captured WebSocket or SFrame packets | SFrame counter window rejection + ScyllaDB 24h client deduplication table |
