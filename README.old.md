# BabyLink Docker Setup

BabyLink is a secure WebRTC baby monitor with voice activation, PWA support, and screen wake lock functionality. This Docker setup automatically detects SSL certificates and runs BabyLink in either HTTPS or HTTP mode.

## 🆕 New Features

- **🔒 Secure Room IDs**: Impossible-to-guess room identifiers for enhanced security
- **📱 PWA Support**: Install as a native app with offline capabilities
- **🔋 Wake Lock**: Prevents screen from turning off during monitoring
- **💾 Room Memory**: Saves previous rooms locally for easy access
- **📤 QR Code Sharing**: Easy room sharing via QR codes
- **🎯 Voice Activation**: Smart audio monitoring with manual overrides

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

## 🔐 Security Features

### Room Management
- **Secure Room IDs**: 32-character cryptographically secure random IDs
- **User-Friendly Names**: Create rooms with memorable names (e.g., "Child1", "Nursery")
- **Local Storage**: Previous rooms saved locally, no server-side storage
- **Easy Sharing**: QR codes and copy-paste links for room sharing

### Privacy & Security
- End-to-end WebRTC communication
- No audio stored on servers
- Secure random room generation
- Local-only room history storage

## 📱 PWA (Progressive Web App) Benefits

Installing BabyLink as a PWA provides several advantages:

1. **🚀 Faster Loading**: Cached resources load instantly
2. **📱 Native Feel**: Behaves like a native mobile app
3. **🔔 Background Processing**: Better background operation support
4. **💾 Offline Capability**: Basic functionality works offline
5. **🏠 Home Screen**: Add to home screen like any other app
6. **🔋 Better Power Management**: Optimized for mobile devices
7. **🔒 Enhanced Security**: Served over HTTPS with secure context

### Installing as PWA
1. Open BabyLink in a supported browser (Chrome, Safari, Edge)
2. Look for the "Install App" banner or browser install prompt
3. Click "Install" to add BabyLink to your device
4. Access from home screen or app drawer

## 🔋 Wake Lock Feature

The Screen Wake Lock API prevents your device screen from turning off during monitoring:

- **Why Important**: Prevents WebRTC connections from suspending
- **Battery Aware**: Only active during monitoring sessions
- **Auto-Release**: Automatically released when page is closed
- **Manual Control**: Enable/disable as needed
- **Cross-Platform**: Works on modern browsers and PWA installs

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
babylink/
├── ssl/                    # SSL certificates (optional)
│   ├── cert.pem           # SSL certificate
│   └── key.pem            # Private key
├── public/                # Static files
│   ├── client.js          # Updated client with wake lock
│   ├── style.css          # Styling
│   ├── manifest.json      # PWA manifest
│   ├── service-worker.js  # Service worker for PWA
│   └── icons/             # PWA icons directory
│       ├── icon-72x72.png
│       ├── icon-96x96.png
│       ├── icon-128x128.png
│       ├── icon-144x144.png
│       ├── icon-152x152.png
│       ├── icon-192x192.png
│       ├── icon-384x384.png
│       └── icon-512x512.png
├── views/                 # HTML templates
│   ├── index.html         # Updated with room management
│   ├── select-role.html   # Updated with QR sharing
│   └── webrtc.html        # Updated with wake lock
├── logs/                  # Application logs (created by Docker)
├── server.js              # HTTPS server
├── server-http.js         # HTTP server
├── package.json           # Updated dependencies
├── Dockerfile
├── docker-compose.yaml    # Updated for BabyLink
├── nginx.conf             # Nginx configuration
└── .dockerignore
```

## Docker Commands

```bash
# Build the image
docker build -t babylink .

# Run container directly
docker run -d -p 3001:3001 -v $(pwd)/ssl:/app/ssl:ro --name babylink-app babylink

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

## 🎯 Usage Guide

### Creating a Room
1. Visit BabyLink homepage
2. Enter a memorable room name (e.g., "Child1", "Nursery")
3. Click "Create Room" - a secure random ID is generated
4. Share the room via QR code or copy the link

### Joining a Room
1. **From Previous Rooms**: Select from your saved rooms list
2. **Via QR Code**: Scan the QR code with your camera
3. **Via Link**: Click the shared link or paste the room ID
4. **Manual Entry**: Enter the room ID in the join form

### Setting Up Monitoring
1. **Baby Device**: Select "Baby Device" role, grant microphone access
2. **Parent Device**: Select "Parent Device" role, enable monitoring
3. **Wake Lock**: Enable to prevent screen from turning off
4. **Voice Activation**: Automatic based on baby's voice levels

## Health Check

The container includes a health check that verifies the application is responding:

```bash
# Check container health
docker ps
# Look for "healthy" status

# Manual health check
docker exec babylink-app curl -f http://localhost:3001 || exit 1
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker-compose logs babylink

# Check if port is in use
netstat -tulpn | grep 3001

# Restart container
docker-compose restart babylink
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
- Enable wake lock to prevent connection suspension

### Audio Issues in Browser
- WebRTC audio requires HTTPS in production
- Use self-signed certificates for local development
- Check browser console for autoplay policy violations
- Grant microphone permissions when prompted
- Enable wake lock to maintain connection stability

### PWA Installation Issues
- Ensure HTTPS is enabled (required for PWA)
- Check that manifest.json is accessible
- Verify service worker registration in browser dev tools
- Clear browser cache and try again

## Production Deployment

For production deployment:

1. **Use real SSL certificates** (Let's Encrypt recommended)
2. **Enable nginx proxy** for better performance
3. **Configure firewall** to allow ports 80, 443, and 3001
4. **Set up monitoring** and log rotation
5. **Use a reverse proxy** like nginx or Traefik
6. **Configure STUN/TURN servers** for better WebRTC connectivity
7. **Generate PWA icons** in all required sizes
8. **Test PWA installation** on target devices

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
- Monitor for unusual connection patterns
- Implement rate limiting for room creation

## Browser Compatibility

### Wake Lock API Support
- Chrome 84+ (Desktop & Mobile)
- Edge 84+
- Safari 16.4+ (iOS 16.4+)
- Firefox: Planned support

### PWA Support
- Chrome/Chromium browsers
- Safari (iOS 11.3+, macOS 10.14.4+)
- Edge
- Firefox (limited PWA features)

### WebRTC Support
- All modern browsers
- Requires HTTPS in production
- Some mobile browsers may have limitations

## Contributing

When contributing to BabyLink:

1. Maintain security focus in all changes
2. Test PWA functionality on multiple devices
3. Verify wake lock behavior on supported browsers
4. Ensure WebRTC compatibility across browsers
5. Follow existing code style and patterns
6. Update documentation for new features

## License

BabyLink is licensed under the BSD-3-Clause License.
