# BabyLink Deployment Guide

This guide covers deploying BabyLink in various environments.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Production Deployment with Caddy](#production-deployment-with-caddy)
- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)
- [Monitoring & Maintenance](#monitoring--maintenance)

---

## Prerequisites

- **Node.js**: v16+ (v18+ recommended)
- **npm**: v8+
- **Caddy**: v2.6+ (for production HTTPS)
- **Docker & Docker Compose**: Optional, for containerized deployment

---

## Local Development

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Environment File

```bash
cp .env.example .env
```

Edit `.env` to configure your local environment (defaults work for most cases).

### 3. Run Development Server

```bash
npm run dev
```

The application will be available at **http://localhost:3001**

### 4. (Optional) Local HTTPS with Caddy

For testing HTTPS locally:

```bash
# Install Caddy (macOS example)
brew install caddy

# Use the local Caddyfile
caddy run --config Caddyfile.local
```

Access at **https://localhost**

---

## Production Deployment with Caddy

Caddy provides automatic HTTPS with Let's Encrypt SSL certificates.

### Architecture

```
Internet (HTTPS) → Caddy (SSL Termination) → BabyLink (HTTP:3001)
```

### 1. Install Caddy

**Ubuntu/Debian:**
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

**Other platforms:** https://caddyserver.com/docs/install

### 2. Configure Caddy

Edit `Caddyfile` and replace `babylink.example.com` with your domain:

```caddy
yourdomain.com {
    reverse_proxy localhost:3001
}
```

### 3. Install BabyLink

```bash
# Clone repository
git clone <your-repo-url> babylink
cd babylink

# Install dependencies
npm ci --only=production

# Create environment file
cp .env.example .env

# Edit environment variables
nano .env
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
Environment=NODE_ENV=production

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/babylink/logs

[Install]
WantedBy=multi-user.target
```

**Create user and install:**

```bash
# Create babylink user
sudo useradd -r -s /bin/false babylink

# Copy app to /opt
sudo mkdir -p /opt/babylink
sudo cp -r . /opt/babylink/
sudo chown -R babylink:babylink /opt/babylink

# Enable and start service
sudo systemctl enable babylink
sudo systemctl start babylink
sudo systemctl status babylink
```

### 5. Start Caddy

```bash
# Copy Caddyfile
sudo cp Caddyfile /etc/caddy/Caddyfile

# Reload Caddy
sudo systemctl reload caddy
```

Caddy will automatically obtain and renew SSL certificates from Let's Encrypt.

---

## Docker Deployment

### 1. Build and Run

```bash
# Build image
docker-compose build

# Start services
docker-compose up -d

# View logs
docker-compose logs -f
```

### 2. With Caddy Reverse Proxy

Create `docker-compose.override.yml`:

```yaml
version: '3.8'

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
docker-compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

---

## Environment Configuration

### Required Variables

```env
NODE_ENV=production
PORT=3001
```

### Optional Variables

```env
# WebRTC Configuration
STUN_SERVER=stun:stun.l.google.com:19302
# TURN_SERVER=turn:turn.example.com:3478
# TURN_USERNAME=username
# TURN_PASSWORD=password

# Room Limits
MAX_ROOMS=1000
MAX_BABIES_PER_ROOM=5
MAX_PARENTS_PER_ROOM=10

# Security
RATE_LIMIT_WINDOW=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
SESSION_SECRET=your-secure-random-secret-here

# Logging
LOG_LEVEL=info
LOG_TO_FILE=true
LOG_FILE_PATH=./logs/babylink.log

# CORS (if needed)
# CORS_ORIGIN=https://yourdomain.com
```

**Generate secure secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Monitoring & Maintenance

### Health Check

```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 12345.67,
  "timestamp": "2025-01-01T00:00:00.000Z",
  "rooms": 5,
  "version": "1.0.0"
}
```

### Logs

**System service:**
```bash
sudo journalctl -u babylink -f
```

**Docker:**
```bash
docker-compose logs -f babylink
```

**Application logs:**
```bash
tail -f logs/babylink.log
tail -f logs/error.log
```

### Restart Service

**System service:**
```bash
sudo systemctl restart babylink
```

**Docker:**
```bash
docker-compose restart babylink
```

### Update Deployment

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
docker-compose build
docker-compose up -d
```

---

## Security Checklist

- [ ] Set secure `SESSION_SECRET` in `.env`
- [ ] Configure HTTPS with Caddy
- [ ] Set appropriate `CORS_ORIGIN` if needed
- [ ] Enable firewall (allow 80, 443, SSH only)
- [ ] Keep Node.js and dependencies updated
- [ ] Monitor logs for suspicious activity
- [ ] Set up automatic backups (if using persistent storage)
- [ ] Configure rate limiting appropriately
- [ ] Review security headers (configured by helmet.js)

---

## Performance Tuning

### For High Traffic

1. **Increase room limits:**
   ```env
   MAX_ROOMS=5000
   MAX_BABIES_PER_ROOM=10
   MAX_PARENTS_PER_ROOM=20
   ```

2. **Add TURN server** (for difficult network scenarios):
   ```env
   TURN_SERVER=turn:turn.example.com:3478
   TURN_USERNAME=user
   TURN_PASSWORD=pass
   ```

3. **Enable log rotation:**
   ```bash
   sudo nano /etc/logrotate.d/babylink
   ```
   ```
   /opt/babylink/logs/*.log {
       daily
       missingok
       rotate 14
       compress
       delaycompress
       notifempty
       create 0640 babylink babylink
       sharedscripts
       postrotate
           systemctl reload babylink
       endscript
   }
   ```

---

## Troubleshooting

### Service Won't Start

Check logs:
```bash
sudo journalctl -u babylink -n 50
```

Common issues:
- Port 3001 already in use: `sudo lsof -i :3001`
- Missing dependencies: `npm install`
- Wrong Node version: `node --version` (need 16+)

### WebRTC Connection Issues

1. Check STUN server is accessible
2. Add TURN server for NAT traversal
3. Verify firewall rules allow UDP traffic
4. Check browser console for errors

### Can't Access via HTTPS

1. Verify Caddy is running: `sudo systemctl status caddy`
2. Check Caddy logs: `sudo journalctl -u caddy`
3. Verify DNS points to your server
4. Check firewall allows ports 80 and 443

---

## Support

For issues, please check:
- [GitHub Issues](your-repo-url/issues)
- Application logs
- Browser console (F12)

---

**Next:** See [README.md](README.md) for usage instructions and features.
