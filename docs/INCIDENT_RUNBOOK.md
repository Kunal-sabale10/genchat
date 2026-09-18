# GenChat Production Incident Response Runbook

Version: 1.1.0  
Owner: Platform Reliability Engineering  
Escalation Policy: PagerDuty / SRE Tier-1  

---

## 1. Incident Severity Definitions

| Severity | Definition | Target SLA (Ack / Mitigate) | Example Scenarios |
|---|---|---|---|
| **Sev-1** | Catastrophic outage; full service impairment across all users | 5 min / 30 min | Redis cluster failure, complete WebSocket drop, Auth DB offline |
| **Sev-2** | Critical degradation; core feature impaired for large cohort | 15 min / 2 hours | Cross-pod message delivery failing, push notification outage |
| **Sev-3** | Minor degradation; non-blocking feature failure | 1 hour / 24 hours | Media upload latency spike, typing indicators delayed |
| **Sev-4** | Low impact; administrative or cosmetic anomalies | Next business day | Log indexing backlog, metric scrape timeouts |

---

## 2. On-Call Runbooks by Failure Mode

### 2.1 Scenario A: Gateway 503 Spikes & Connection Ceiling Saturation

#### Symptoms
* Ingress returns `503 Service Unavailable` with `Retry-After: 3`
* Prometheus alert `GatewayConnectionCapacityExceeded` firing
* `gateway_active_connections` >= 95% of `MAX_CONNECTIONS_PER_POD * replicas`

#### Immediate Mitigation Steps
1. **Scale Pod Replicas**:
   ```bash
   kubectl scale deployment gateway --replicas=+10 -n genchat
   ```
2. **Verify Memory Headroom**:
   Ensure gateway pods are not being OOMKilled by verifying `GOMEMLIMIT=1800MiB` vs container limit `2Gi`.
3. **Inspect Active Descriptors**:
   ```bash
   kubectl exec -it <gateway-pod-id> -n genchat -- netstat -an | grep 8081 | wc -l
   ```
4. **Traffic Shedding**:
   If the downstream Redis presence cluster is bottlenecked, shed 10% of idle sockets by triggering a staggered rolling restart:
   ```bash
   kubectl rollout restart deployment gateway -n genchat
   ```

---

### 2.2 Scenario B: Redis Presence Directory Partition / Latency Spike

#### Symptoms
* Redis cluster CPU > 90% or `redis_connected_clients` spiking
* Cross-pod delivery latency > 250ms
* Gateway readiness probe `/readyz` returning HTTP 503 (`redis unreachable`)

#### Immediate Mitigation Steps
1. **Check Redis Replication Status**:
   ```bash
   redis-cli -h redis.genchat.svc.cluster.local -p 6379 INFO replication
   ```
2. **Identify Top Memory Consumers**:
   ```bash
   redis-cli -h redis.genchat.svc.cluster.local -p 6379 MEMORY USAGE presence:online
   ```
3. **Failover to Standby Replica**:
   If primary Redis node is unresponsive or memory-corrupted, initiate sentinel failover:
   ```bash
   redis-cli -h redis-sentinel.genchat.svc.cluster.local -p 26379 SENTINEL FAILOVER mymaster
   ```
4. **Flush Ephemeral Gateway Mappings**:
   If orphaned pod mappings persist after a hard node termination:
   ```bash
   redis-cli -h redis.genchat.svc.cluster.local -p 6379 EVAL "for _,k in ipairs(redis.call('keys','gw:*:users')) do redis.call('del',k) end" 0
   ```

---

### 2.3 Scenario C: ScyllaDB Message Ledger Latency / Backpressure

#### Symptoms
* Message acknowledgment latency > 500ms
* Gateway write queue filling up, memory approaching high watermark
* ScyllaDB node reporting high disk utilization or compaction backlog

#### Immediate Mitigation Steps
1. **Verify Cluster Health**:
   ```bash
   nodetool status
   nodetool tpstats
   ```
2. **Check Compaction Backlog**:
   ```bash
   nodetool compactionstats
   ```
3. **Tune Read/Write Consistency**:
   Ensure gateway writes remain `LOCAL_QUORUM`. Under extreme degraded single-node failure, check cluster keyspace replication factor:
   ```cql
   DESCRIBE KEYSPACE genchat;
   ```

---

### 2.4 Scenario D: Auth Service Database Connection Exhaustion

#### Symptoms
* Auth service returns `500 Internal Server Error` on `/auth/login` or `/auth/refresh`
* Postgres log: `FATAL: remaining connection slots are reserved for non-replication superuser connections`

#### Immediate Mitigation Steps
1. **Check PgBouncer / Pool Status**:
   ```sql
   SELECT count(*), state, client_addr FROM pg_stat_activity GROUP BY state, client_addr;
   ```
2. **Kill Idle Connections**:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction' AND state_change < current_timestamp - INTERVAL '5 minutes';
   ```
3. **Adjust Auth Pool Limits**:
   If traffic spiked legitimately, increase pool cap in Helm `values.yaml` and apply.

---

## 3. Post-Mortem and Incident Closure

1. Update status page to Operational.
2. Conduct post-incident retrospective within 72 hours.
3. Archive telemetry dashboards and audit logs for forensic review.
