# GenChat Kubernetes Production Deployment & Helm Operations Guide

Version: 1.0.0  
Target Platform: Kubernetes v1.28+ (EKS / GKE / AKS / Bare-Metal)  
Chart Path: `deploy/helm/genchat`  

---

## 1. Architectural Topology

The GenChat production topology separates stateless real-time edge processing from stateful backends:

```
                  [ Ingress / AWS NLB / Cloudflare ]
                                   |
                                   v
                         [ Envoy Proxy Fleet ]
                                   |
        +--------------------------+--------------------------+
        |                          |                          |
        v                          v                          v
[ Gateway Fleet ]            [ Auth Service ]           [ Media Service ]
 (WebSocket Edge)             (Identity & Keys)          (Presigned S3 API)
        |                          |                          |
        +------------+-------------+                          |
                     |                                        v
                     v                                 [ MinIO / S3 ]
            [ Message Ledger ]
           (Monotonic Sequencer)
                     |
       +-------------+-------------+
       v                           v
 [ ScyllaDB ]                 [ Redis ]
(Message Store)          (Presence Directory)
```

---

## 2. Cluster Prerequisites

Before deploying the Helm chart, ensure the following backing services are provisioned in the target namespace or accessible via internal VPC DNS:

1. **PostgreSQL 17**: Dedicated cluster with connection pooling (PgBouncer recommended).
2. **ScyllaDB 6.2+**: 3+ node ring running in `LocalQuorum` consistency mode.
3. **Redis 7 (Alpine)**: Standalone or Sentinel/Cluster with persistence enabled (AOF or RDB).
4. **MinIO / AWS S3**: High-throughput object storage bucket `genchat-media`.

---

## 3. Production Deployment via Helm

### 3.1 Namespace & Secret Configuration

Create the target namespace and provision production secrets using `kubectl` or ExternalSecrets Operator:

```bash
kubectl create namespace genchat

# Provision JWT and database credentials
kubectl create secret generic genchat-production-secrets \
  --namespace genchat \
  --from-literal=jwt-secret="$(openssl rand -base64 32)" \
  --from-literal=postgres-password="<STRONG_POSTGRES_PASSWORD>" \
  --from-literal=minio-secret-key="<STRONG_MINIO_SECRET_KEY>"
```

### 3.2 Helm Chart Installation

Deploy or upgrade the GenChat release using values overrides:

```bash
helm upgrade --install genchat ./deploy/helm/genchat \
  --namespace genchat \
  --values ./deploy/helm/genchat/values.yaml \
  --set global.environment=production \
  --set global.domain=chat.yourcompany.com \
  --set global.jwtSecret="<PRODUCTION_JWT_SECRET>" \
  --set gateway.replicaCount=5 \
  --set gateway.autoscaling.enabled=true \
  --set gateway.maxConnectionsPerPod=10000 \
  --wait --timeout 10m
```

---

## 4. Autoscaling & Traffic Management

### 4.1 Connection-Based Horizontal Pod Autoscaling (HPA)

The gateway scales dynamically based on total active WebSocket connections:

```yaml
gateway:
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetAverageConnections: 10000
```

The Prometheus adapter exposes custom metric `gateway_active_connections`. When average connection count exceeds 10,000 per pod, Kubernetes provisions additional gateway pods.

### 4.2 Graceful Draining & Pod Disruption Budgets

To prevent dropping active user conversations during rolling upgrades:
- `terminationGracePeriodSeconds` is configured to `65s`.
- On `SIGTERM`, the gateway pod:
  1. Fails the Kubernetes readiness probe `/readyz` to stop receiving new connections from the load balancer.
  2. Waits for active messages to drain.
  3. Sends graceful closure frames to connected WebSockets.
  4. Flushes the Redis presence directory for its pod ID.

---

## 5. Day-2 Operations & Health Verification

### 5.1 Verifying Pod Readiness Probes

Validate all service pods are passing liveness and readiness checks:

```bash
kubectl get pods -n genchat -l app.kubernetes.io/name=genchat
```

### 5.2 Checking Service Health Endpoints

```bash
# Gateway readiness & cluster presence
kubectl exec -it deployment/gateway -n genchat -- curl -s http://localhost:8081/readyz

# Auth database readiness
kubectl exec -it deployment/auth -n genchat -- curl -s http://localhost:8080/readyz

# Media storage readiness
kubectl exec -it deployment/media -n genchat -- curl -s http://localhost:8082/readyz
```

### 5.3 Rollback Procedure

If an issue is detected post-deployment, roll back immediately to the previous revision:

```bash
helm rollback genchat -n genchat
```
