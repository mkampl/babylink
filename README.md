# Babyphone Docker Setup

This Docker setup automatically detects SSL certificates and runs the baby monitor in either HTTPS or HTTP mode.

## Quick Start

### 1. Basic HTTP Setup (No SSL)

```bash
# Build and run the container
docker-compose up -d

# View logs
docker-compose logs -f

# Access the app
# HTTP: http://localhost:3001
```

### 2. HTTPS Setup (With SSL Certificates)

```bash
# Create SSL directory
mkdir ssl

# Place your SSL certificates in the ssl directory:
# ssl/cert.pem (your certificate)
# ssl/key.pem (your private key)

# Build and run
docker-compose up -d

# The app will automatically detect certificates and run in HTTPS mode
# HTTPS: https://localhost:3001
```

### 3. With Nginx Proxy (Production)

```bash
# Run with nginx reverse proxy
docker-compose --profile proxy up -d

# Access via nginx:
# HTTP: http://localhost:80
# HTTPS: https://localhost:443 (if SSL configured)
```

## SSL Certificate Generation

### Self-Signed Certificates (Development)

```bash
# Create ssl directory
mkdir ssl

# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes

# You'll be prompted to enter certificate information
# For local development, you can use localhost as Common Name
```

### Let's Encrypt (Production)

```bash
# Install certbot
sudo apt-get install certbot

# Generate certificate (replace yourdomain.com)
sudo certbot certonly --standalone -d yourdomain.com

# Copy certificates to ssl directory
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem ssl/cert.pem
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem ssl/key.pem
sudo chown $USER:$USER ssl/*.pem
```

## Directory Structure

```
babyphone/
├── ssl/                    # SSL certificates (optional)
│   ├── cert.pem           # SSL certificate
│   └── key.pem            # Private key
├── public/                # Static files
│   ├── client.js
│   └── style.css
├── views/                 # HTML templates
│   ├── index.html
│   ├── select-role.html
│   └── webrtc.html
├── logs/                  # Application logs (created by Docker)
├── server.js              # HTTPS server
├── server-http.js         # HTTP server
├── package.json
├── Dockerfile
├── docker-compose.yaml
├── nginx.conf             # Nginx configuration
└── .dockerignore
```

## Docker Commands

```bash
# Build the image
docker build -t babyphone .

# Run container directly
docker run -d -p 3001:3001 -v $(pwd)/ssl:/app/ssl:ro --name babyphone-app babyphone

# Using docker-compose (recommended)
docker-compose up -d                    # Start in background
docker-compose down                     # Stop and remove containers
docker-compose logs -f                  # View logs
docker-compose restart                  # Restart services
docker-compose pull                     # Update images

# With nginx proxy
docker-compose --profile proxy up -d    # Start with nginx
docker-compose --profile proxy down     # Stop nginx setup
```

## Environment Variables

You can customize the setup using environment variables:

```bash
# Set in docker-compose.yaml or .env file
PORT=3001                   # Application port
NODE_ENV=production         # Node environment
```

## Health Check

The container includes a health check that verifies the application is responding:

```bash
# Check container health
docker ps
# Look for "healthy" status

# Manual health check
docker exec babyphone-app curl -f http://localhost:3001 || exit 1
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker-compose logs babyphone

# Check if port is in use
netstat -tulpn | grep 3001

# Restart container
docker-compose restart babyphone
```

### SSL Issues
```bash
# Verify certificate files exist
ls -la ssl/

# Check certificate validity
openssl x509 -in ssl/cert.pem -text -noout

# Test HTTPS connection
curl -k https://localhost:3001
```

### WebRTC Connection Issues
- Make sure both devices can reach the server
- For external access, configure your router's port forwarding
- Consider using STUN/TURN servers for complex network setups

### Audio Issues in Browser
- WebRTC audio requires HTTPS in production
- Use self-signed certificates for local development
- Check browser console for autoplay policy violations

## Production Deployment

For production deployment:

1. **Use real SSL certificates** (Let's Encrypt recommended)
2. **Enable nginx proxy** for better performance
3. **Configure firewall** to allow ports 80, 443, and 3001
4. **Set up monitoring** and log rotation
5. **Use a reverse proxy** like nginx or Traefik
6. **Configure STUN/TURN servers** for better WebRTC connectivity

### Example Production Setup

```bash
# 1. Get SSL certificates
sudo certbot certonly --standalone -d yourdomain.com

# 2. Copy certificates
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem ssl/cert.pem
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem ssl/key.pem
sudo chown $USER:$USER ssl/*.pem

# 3. Update nginx.conf for HTTPS
# Uncomment the HTTPS server block in nginx.conf

# 4. Start with nginx proxy
docker-compose --profile proxy up -d

# 5. Set up auto-renewal for certificates
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet && docker-compose restart nginx
```

## Security Considerations

- Use strong SSL certificates in production
- Keep Docker images updated
- Limit network access to necessary ports
- Use non-root user in container (already configured)
- Regular security updates for dependencies
- Consider using Docker secrets for sensitive data
