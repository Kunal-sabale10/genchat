# Gateway Resilience, Load Shedding & Device Hygiene Runbook

This document details the high-availability, resilience, and connection defense mechanisms implemented in GenChat’s real-time Gateway service (`gatewayd`).

---

## 1. Hard Connection Ceiling & Graceful 503 Rejection

Each `gatewayd` pod enforces a hard maximum connection ceiling (`MAX_CONNECTIONS_PER_POD`, default `50000`):
- **Mechanism**: Evaluated synchronously at WebSocket upgrade time in `ws/handler.go` via `hub.TotalConnections()`.
- **Response**: Rejects surplus connections with `HTTP 503 Service Unavailable` and a `Retry-After: 30` header.
- **Metric**: Increments `gateway_connection_capacity_rejections_total`.
- **Runbook**: If `GatewayConnectionCapacityRejections` alert triggers, verify HPA scale-out triggers and review ingress load balancing algorithms (e.g. least-connection routing).

---

## 2. Per-User Device Limit & Session Supersession

To enforce authentication hygiene and prevent unbounded socket resource consumption:
- **Ceiling**: A single user account can have at most 5 concurrent active devices (`MAX_DEVICES_PER_USER=5`).
- **Same-Device Supersession**: If an existing device reconnects with a fresh socket, the older connection for that specific `device_id` is cleanly evicted via `hub.EvictDeviceConnections(userID, deviceID)`, keeping the account device count stable.
- **6th Device Rejection**: Connecting a 6th unique device ID returns `HTTP 403 Forbidden` (`maximum active devices reached for this user`).
- **Metric**: Increments `gateway_device_limit_rejections_total`.

---

## 3. Active Sessions Management & Remote Revocation

Users can view and manage their authenticated devices from the web client:
- **Endpoints**:
  - `GET /api/v1/sessions`: Lists all active sessions for the caller (`id`, `device_id`, `device_label`, `created_at`, `last_seen_at`, `is_current`).
  - `DELETE /api/v1/sessions/{id}` / `POST /api/v1/sessions/revoke`: Invalidates the session in PostgreSQL and cuts off refresh token renewal.
- **Frontend**: The `ActiveSessionsModal` component in `packages/client-web` renders linked devices, icons, and a one-click revocation action with confirmation safeguards.

---

## 4. Priority Load-Shedding Circuit Breaker

Protects active real-time sessions from cascading node failure under severe CPU, memory, or goroutine pressure:
- **Goroutine Threshold**: Monitored via `runtime.NumGoroutine()` against `MAX_GOROUTINES` (default `25000`).
- **Heap Memory Threshold**: Monitored via `runtime.ReadMemStats()` against `MAX_HEAP_MB` (default `1024MB`).
- **Behavior**: When tripped, the gateway rejects incoming handshakes with `HTTP 503 Service Unavailable` (`Retry-After: 60`), preserving compute cycles for existing active WebSocket pumps.
- **Metric**: Increments `gateway_loadshed_rejections_total`.

---

## 5. Multi-Tier Rate Limiting Architecture

1. **Pre-Auth IP Rate Limiter**:
   - Enforced on the raw HTTP handshake before JWT decoding (`PREAUTH_RATE_PER_MINUTE=60`, `PREAUTH_BURST=10`).
   - Thwarts connection-flood DDoS attacks before cryptographic CPU cycles are spent.
   - Rejection returns `HTTP 429 Too Many Requests` (`Retry-After: 10`) and increments `gateway_preauth_rate_limit_rejections_total`.
   - Exempts loopback and internal private IPs in dev/test mode (`WS_ALLOW_ANY_ORIGIN=true`).

2. **Fresh vs. Steady-State Message Rate Limiting**:
   - **Fresh Connection Tier** (`WS_FRESH_RATE_PER_MINUTE=60`, `WS_FRESH_BURST=10` in production): Applied during the first 30 seconds of connection lifetime to absorb reconnect bursts without triggering message storms.
   - **Steady-State Tier** (`WS_RATE_PER_MINUTE=1200`, `WS_RATE_BURST=100`): Normal operating limit once the connection passes the initial 30-second window.
   - In dev/testing, the fresh tier automatically scales to match steady-state throughput.

---

## 6. Cluster Redis Presence & Push Notification Optimization

- Gateway instances maintain active socket presence in Redis (`user:{id}:gateways` set and `user:{id}:gateway_instance` key).
- Before dispatching APNs/FCM background pushes, the router executes `hub.IsUserOnlineCluster(ctx, userID)`:
  - First checks the local in-memory pod hub.
  - If not local, queries the Redis presence directory across all pods.
  - Skips redundant push notifications when the recipient is actively chatting on another gateway instance.
