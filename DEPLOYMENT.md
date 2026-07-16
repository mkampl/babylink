# BabyLink Deployment Guide

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Production Deployment with Caddy](#production-deployment-with-caddy)
- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)
- [Running a public / demo instance](#running-a-public--demo-instance)
- [Monitoring & Maintenance](#monitoring--maintenance)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js**: v16+ (v18+ recommended)
- **npm**: v8+
- **Caddy**: v2.6+ (for production HTTPS)
- **Docker + Docker Compose v2**: optional, for containerised deployment

---

## Local Development

### 1. Install Dependencies

```bash
npm install
```

### 2. Run the Server

```bash
npm start
```

Available at **http://localhost:3001**.

### 3. (Optional) Local HTTPS with Caddy

`getUserMedia` requires a secure context. On `localhost` plain HTTP works,
but on a LAN IP you need TLS. The bundled `Caddyfile.local` sets up a
self-signed certificate:

```bash
caddy run --config Caddyfile.local
```

Access at **https://localhost** (accept the self-signed cert warning).

---

## Production Deployment with Caddy

Caddy provides automatic HTTPS with Let's Encrypt.

### Architecture

```
Internet (HTTPS) → Caddy (TLS termination) → BabyLink (HTTP :3001)
```

### 1. Install Caddy

**Ubuntu / Debian:**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

**Other platforms:** https://caddyserver.com/docs/install

### 2. Configure Caddy

Edit `Caddyfile` and replace `babylink.itvoodoo.at` with your domain:

```caddy
babylink.itvoodoo.at {
    reverse_proxy localhost:3001
}
```

### 3. Install BabyLink

```bash
git clone https://github.com/mkampl/babylink babylink
cd babylink
npm ci --only=production
cp .env.example .env
nano .env   # set NODE_ENV=production and PUBLIC_HOST=babylink.itvoodoo.at
```

### 4. Set Up as System Service

Create `/etc/systemd/system/babylink.service`:

```ini
[Unit]
Description=BabyLink Baby Monitor
After=network.target

[Service]
Type=simple
User=babylink
WorkingDirectory=/opt/babylink
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/babylink/.env

[Install]
WantedBy=multi-user.target
```

**Install and start:**

```bash
sudo useradd -r -s /bin/false babylink
sudo mkdir -p /opt/babylink
sudo cp -r . /opt/babylink/
sudo chown -R babylink:babylink /opt/babylink
sudo systemctl enable --now babylink
```

### 5. Start Caddy

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews Let's Encrypt certificates automatically.

---

## Docker Deployment

### 1. Build and Run

```bash
# Build and start
PUBLIC_HOST=babylink.itvoodoo.at docker compose up -d --build

# View logs
docker compose logs -f
```

`PUBLIC_HOST` is mandatory: it is the address the server advertises to
ESP32-S3 devices during BLE provisioning. Set it to your domain name or
LAN IP as appropriate.

### 2. With Caddy Reverse Proxy

Create `docker-compose.override.yml`:

```yaml
services:
  caddy:
    image: caddy:alpine
    container_name: babylink-caddy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - babylink
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

---

## Environment Configuration

### Key Variables

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `NODE_ENV` | `development` | Set `production` to trim logs |
| `PORT` | `3001` | HTTP port the server listens on |
| `PUBLIC_HOST` | auto | Host advertised to ESP32-S3 devices. **Must be set in Docker.** |
| `PUBLIC_PORT` | `$PORT` | Port advertised to ESP32-S3 devices |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Per-IP request cap per 15-minute window |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

### WebRTC / TURN

```env
STUN_SERVER=stun:stun.l.google.com:19302
# TURN_SERVER=turn:turn.example.com:3478
# TURN_USERNAME=username
# TURN_PASSWORD=password
```

### Room limits

```env
MAX_BABIES_PER_ROOM=5
MAX_PARENTS_PER_ROOM=10
```

---

## Running a public / demo instance

Things to know before exposing BabyLink to the internet.

**Data that persists in `data/`:**
Room configuration (PIN hashes, ntfy topics, device associations) is
written to `data/` and survives restarts. Rooms do not expire
automatically; add a cron task or admin script if you want a TTL.

**What the server can see:**
The server sees signaling metadata (room membership, join/leave events),
client IP addresses in logs, and Opus audio frames relayed from
ESP32-S3 devices. WebRTC audio between two browsers never traverses the
server. See [SECURITY.md](SECURITY.md) for the full breakdown.

**Abuse considerations:**

- Rate limiting is on by default (`RATE_LIMIT_MAX_REQUESTS=100` per 15
  min). Tighten it for public instances.
- Room creation is unauthenticated; anyone with network access can
  create rooms. Consider adding a reverse-proxy basic-auth layer or
  keeping `MAX_ROOMS` set to a conservative value to cap server load.
- Room IDs are 128-bit random tokens, but the server does not
  time-out idle rooms. Monitor room count via `/health`.

**Health endpoint:**

```bash
curl https://babylink.itvoodoo.at/health
```

```json
{
  "status": "healthy",
  "uptime": 12345.67,
  "timestamp": "2025-01-01T00:00:00.000Z",
  "rooms": 5,
  "esp32Devices": 2,
  "version": "1.0.0"
}
```

---

## Monitoring & Maintenance

### Logs

```bash
# System service
sudo journalctl -u babylink -f

# Docker
docker compose logs -f babylink
```

### Restart

```bash
# System service
sudo systemctl restart babylink

# Docker
docker compose restart babylink
```

### Update

**System service:**

```bash
cd /opt/babylink
sudo -u babylink git pull
sudo -u babylink npm ci --only=production
sudo systemctl restart babylink
```

**Docker:**

```bash
git pull
docker compose up -d --build
```

---

## Troubleshooting

### Service won't start

```bash
sudo journalctl -u babylink -n 50
```

Common causes: port 3001 in use (`sudo lsof -i :3001`); missing
dependencies (`npm install`); wrong Node version (`node --version`,
need 16+).

### Can't use microphone on LAN IP

`getUserMedia` requires a secure context. Plain HTTP only works on
`localhost`. Use `Caddyfile.local` for local TLS or run behind Caddy
with a real certificate. See the Quick Start section in
[README.md](README.md) for options.

### WebRTC connection issues

1. Verify the STUN server is reachable.
2. Add a TURN server for NAT traversal (`TURN_SERVER`, `TURN_USERNAME`,
   `TURN_PASSWORD`).
3. Check firewall rules allow UDP traffic.
4. Open the browser console (F12) for ICE errors.

### Can't reach HTTPS endpoint

1. `sudo systemctl status caddy`
2. `sudo journalctl -u caddy`
3. Verify DNS points to your server and ports 80 + 443 are open.

---

See [README.md](README.md) for usage and feature overview.
