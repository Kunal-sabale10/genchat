# GenChat Phase 1 — Secure E2EE Messaging

## Overview
GenChat Phase 1 is a secure, end-to-end encrypted (E2EE) messaging platform leveraging modern cryptographic protocols to ensure data privacy and security.

## Architecture
- **Clients**: Web, Mobile (gRPC-Web, HTTP/2)
- **Edge Proxy**: Envoy (TLS 1.3 termination, gRPC-Web proxy, rate limiting)
- **Microservices** (Go):
  - **Auth Service**: Manages user authentication and public keys.
  - **Gateway Service**: Edge service proxying logic and connection management.
  - **Ledger Service**: Scalable storage and retrieval of encrypted messages.
- **Crypto Core** (Rust): FFI and core cryptographic primitives (Ed25519, X25519, ChaCha20-Poly1305, HKDF).
- **Storage**:
  - PostgreSQL (Relational data, user accounts)
  - ScyllaDB (High-throughput message ledger)
  - Redis (Pub/Sub, state, caching)

## Prerequisites
- Go 1.24+
- Rust 1.75+
- Docker & Docker Compose
- `protoc` (Protocol Buffers Compiler)
- `golang-migrate`

## Quick Start
1. Start infrastructure:
   ```bash
   make docker-up
   ```
2. Run database migrations:
   ```bash
   make migrate-up
   make scylla-migrate
   ```
3. Build the project:
   ```bash
   make all
   ```
4. Run the services (or test them):
   ```bash
   make test
   ```

## Technology Stack
| Component | Technology |
|---|---|
| Services | Go 1.24 |
| Cryptography | Rust 1.75+ |
| Communication | gRPC, gRPC-Web, Protocol Buffers |
| Edge Proxy | Envoy |
| Relational DB | PostgreSQL |
| NoSQL DB | ScyllaDB |
| Caching/PubSub | Redis |

## Project Structure
- `bin/`: Compiled Go binaries
- `crypto/`: Rust core and FFI wrappers
- `deploy/`: Infrastructure configuration (Envoy, Docker)
- `gen/`: Auto-generated protobuf Go code
- `proto/`: Protobuf service and message definitions
- `schema/`: Database schemas and migrations
- `services/`: Go microservices

## License
Apache-2.0
