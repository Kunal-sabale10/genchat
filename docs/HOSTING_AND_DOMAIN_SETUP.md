# GenChat Production Hosting, Domain & TLS Setup Guide

Version: 1.0.0  
Architecture: Docker Compose with Automated Caddy TLS  
Target Deployment: Ubuntu 22.04 / 24.04 LTS (Hetzner, DigitalOcean, AWS EC2, GCP Compute)  

---

## 1. Target Hardware Specifications

For a reliable production launch serving real-time WebSockets, ScyllaDB message sequencing, and MinIO attachments:

* **vCPU**: 4 cores minimum (dedicated recommended)
* **Memory**: 8 GB RAM minimum (ScyllaDB: 2GB, Gateway: 1.8GB, Postgres: 1GB, Redis: 512MB, System: 2.7GB)
* **Disk**: 80 GB+ NVMe SSD
* **Network**: 1 Gbps port with public static IPv4 and IPv6

---

## 2. DNS Record Configuration

Before provisioning TLS certificates, point your domain records to your server IP:

| Type | Host / Name | Value | TTL |
|---|---|---|---|
| **A** | `@` (or `chat`) | `<SERVER_IPV4_ADDRESS>` | 300s |
| **AAAA** | `@` (or `chat`) | `<SERVER_IPV6_ADDRESS>` | 300s |

*Verify DNS propagation before starting Caddy*:
```bash
dig +short A yourdomain.com
```

---

## 3. Host OS & Firewall Hardening

Connect to your VPS and run:

```bash
# Update base system
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker & Docker Compose plugin
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker

# Configure UFW firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp    # HTTP (Let's Encrypt challenge & HTTP/2 redirect)
sudo ufw allow 443/tcp   # HTTPS (WebSockets & API)
sudo ufw allow 443/udp   # HTTP/3 QUIC
sudo ufw allow 3478/udp  # WebRTC STUN/TURN
sudo ufw allow 3478/tcp  # WebRTC STUN/TURN fallback
sudo ufw allow 49152:49160/udp # WebRTC Relay Media Ports
sudo ufw enable
```

---

## 4. Production Secret Initialization

Clone your repository or download release artifacts onto the server:

```bash
cd /opt/genchat

# Copy environment template
cp .env.example .env
chmod 600 .env
```

Edit `.env` and configure production secrets:
```bash
# Domain
GENCHAT_DOMAIN=yourdomain.com
ACME_EMAIL=admin@yourdomain.com

# Cryptographic Keys (generate with openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)
TURN_SHARED_SECRET=$(openssl rand -base64 32)

# Database Passwords
POSTGRES_PASSWORD=$(openssl rand -hex 16)
MINIO_ROOT_USER=genchat_admin
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
```

---

## 5. Deploying the Production Stack

Launch the stack with `docker-compose.prod.yaml`:

```bash
docker compose -f deploy/docker-compose.prod.yaml up -d
```

### Checking Deployment Status
```bash
# Check running containers
docker compose -f deploy/docker-compose.prod.yaml ps

# Inspect Caddy TLS issuance logs
docker compose -f deploy/docker-compose.prod.yaml logs -f caddy
```

Caddy will automatically:
1. Obtain trusted certificates from Let's Encrypt / ZeroSSL.
2. Configure modern TLS 1.3 cipher suites.
3. Automatically redirect `http://yourdomain.com` to `https://yourdomain.com`.
4. Proxy `/ws` with WebSocket upgrade headers to the Gateway service.
5. Serve the pre-built PWA web client with caching headers.

---

## 6. Origin & WebAuthn Verification

Production requires strict origin matching for WebAuthn passkeys and WebSockets:

1. **WebSocket Origin**:
   `WS_ALLOW_ANY_ORIGIN=false` is enforced. Connections attempting cross-site hijacking without `Origin: https://yourdomain.com` are dropped with `403 Forbidden`.
2. **WebAuthn Passkey Registration**:
   `WEBAUTHN_RP_ID=yourdomain.com` matches the domain bar in Chrome, Safari, and Firefox, preventing origin mismatch errors during biometric registration.
