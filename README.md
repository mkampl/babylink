# 👶 BabyLink - Multi-Baby WebRTC Monitor

**BabyLink** is a secure, real-time baby monitor built with WebRTC technology. It supports **multiple babies and multiple parents** in the same room, with voice activity detection, PWA support, and screen wake lock functionality.

[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg)](https://nodejs.org/)

---

## ✨ Features

### 🆕 New in This Version

- **ESP32 Hardware Support** - Use ESP32 with INMP441 I2S microphone as baby device
- **Web Configuration Portal** - Configure WiFi and server settings via captive portal
- **Multi-Baby/Multi-Parent Support** - Monitor multiple babies from one or more parent devices
- **Named Participants** - Give each baby a name for easy identification
- **Individual Controls** - Mute/unmute and volume control for each baby independently
- **Visual Audio Levels** - Real-time audio level indicators for each baby
- **Activity Logs** - Per-baby activity logging
- **Enhanced Security** - Input validation, rate limiting, CORS, helmet.js security headers
- **Production-Ready** - Structured logging with Winston, environment configuration, graceful shutdown
- **Reverse Proxy Ready** - Designed for Caddy/Nginx SSL termination (no built-in SSL)

### 🔒 Security Features

- **Cryptographically Secure Room IDs** - 32-character random hexadecimal identifiers
- **Input Validation** - Server-side validation of all room IDs and user inputs
- **Rate Limiting** - Prevent abuse with configurable rate limits
- **Security Headers** - Helmet.js integration for secure HTTP headers
- **CORS Configuration** - Configurable cross-origin resource sharing
- **No SSL Complexity** - Designed for reverse proxy SSL termination

### 📱 Core Features

- **WebRTC Peer-to-Peer** - Direct audio streaming between devices
- **Voice Activity Detection** - Automatic detection of quiet, movement, and crying
- **Progressive Web App** - Install as native app on any device
- **Screen Wake Lock** - Prevents screen from turning off during monitoring
- **Room History** - Saves last 10 rooms locally for quick access
- **QR Code Sharing** - Easy room sharing with QR codes
- **Manual Controls** - Override automatic voice detection

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Environment File

```bash
cp .env.example .env
# Edit .env with your configuration (optional, defaults work for development)
```

### 3. Run the Server

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

### 4. Access the Application

Open your browser to **http://localhost:3001**

---

## 📖 Usage

### Creating a Room

1. Visit BabyLink homepage
2. Enter a memorable room name (e.g., "Nursery", "Child1")
3. Click **"Create Room"**
4. Share the room via QR code or link

### Joining as Baby Device

**Browser/Phone:**
1. Click "Baby Device"
2. Enter baby's name (e.g., "Emma", "Room 1")
3. Grant microphone access
4. Device will stream audio to all connected parents

**ESP32 Hardware:**
1. Power on ESP32 with INMP441 microphone
2. If unconfigured, connect to `BabyLink-Setup` WiFi network
3. Configure WiFi, server address, and room ID via web portal
4. ESP32 automatically connects and streams audio

### Joining as Parent Device

1. Click "Parent Device"
2. Enter your name (optional)
3. Monitor all babies in the room
4. Control each baby independently:
   - **Mute/Unmute** - Toggle audio for specific baby
   - **Solo** - Listen to only one baby
   - **Volume** - Adjust individual baby volume
   - **Activity Log** - View recent activity per baby

### Multi-Baby Scenarios

**Example 1: One Parent, Two Children**
- 2 baby devices (Emma's phone, Liam's tablet)
- 1 parent device (Mom's laptop)
- Mom can monitor both children simultaneously

**Example 2: Two Parents, One Child**
- 1 baby device (Emma's phone)
- 2 parent devices (Mom's phone, Dad's tablet)
- Both parents receive audio from the same baby

**Example 3: Two Parents, Two Children**
- 2 baby devices (Emma's phone, Liam's tablet)
- 2 parent devices (Mom's phone, Dad's tablet)
- All parents monitor all children

---

## 🎛️ ESP32 Baby Device

### Hardware Requirements
- ESP32 DevKit (ESP32-WROOM-32 or similar)
- INMP441 I2S MEMS Microphone
- USB cable for power/programming

### Wiring
```
ESP32 Pin    →    INMP441 Pin
---------          -----------
3.3V         →    VDD
GND          →    GND
GPIO 26      →    SCK (Serial Clock)
GPIO 25      →    WS  (Word Select)
GPIO 18      →    SD  (Serial Data)
GPIO 5       →    L/R (Left/Right Select)
```

### Firmware Setup
See [`esp32-firmware/`](esp32-firmware/) directory for build instructions.

### First-Time Configuration
1. Flash ESP32 firmware using PlatformIO
2. On first boot, ESP32 creates `BabyLink-Setup` WiFi network
3. Connect phone to this network
4. Web portal opens automatically (or visit `http://192.168.4.1`)
5. Configure:
   - WiFi network credentials
   - BabyLink server address (IP or hostname)
   - Server port (default: 3001)
   - Room ID (from BabyLink web interface)
   - Device name
6. Click "Save & Connect"
7. ESP32 reboots and connects automatically

### Features
- **50x Audio Amplification** - Optimized for INMP441 sensitivity
- **Persistent Configuration** - Settings saved to flash memory
- **Auto-Reconnect** - Automatic WiFi and server reconnection
- **Status LED** - Visual connection indicator (GPIO 2)
- **Low Latency** - ~200ms audio delay
- **Auto-Config Mode** - Fallback to setup portal if WiFi fails

---

## 🔧 Configuration

### Environment Variables

See [`.env.example`](.env.example) for all available configuration options.

**Essential Variables:**

```env
NODE_ENV=production
PORT=3001
SESSION_SECRET=your-secure-random-secret-here
```

**Room Limits:**

```env
MAX_BABIES_PER_ROOM=5
MAX_PARENTS_PER_ROOM=10
MAX_ROOMS=1000
```

**WebRTC Configuration:**

```env
STUN_SERVER=stun:stun.l.google.com:19302
# Optional TURN server for difficult network scenarios
# TURN_SERVER=turn:turn.example.com:3478
# TURN_USERNAME=username
# TURN_PASSWORD=password
```

**Security:**

```env
RATE_LIMIT_WINDOW=900000  # 15 minutes in ms
RATE_LIMIT_MAX_REQUESTS=100
CORS_ORIGIN=*  # Or specify your domain
```

**Logging:**

```env
LOG_LEVEL=info  # error, warn, info, debug
LOG_TO_FILE=true
LOG_FILE_PATH=./logs/babylink.log
```

---

## 🐳 Docker Deployment

### Basic Deployment

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### With Caddy Reverse Proxy

```yaml
# docker-compose.override.yml
version: '3.8'

services:
  caddy:
    image: caddy:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - babylink

volumes:
  caddy_data:
  caddy_config:
```

```bash
docker-compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

---

## 🌐 Production Deployment

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

### 2. Configure Caddy

Edit `Caddyfile`:

```caddy
yourdomain.com {
    reverse_proxy localhost:3001
}
```

### 3. Deploy BabyLink

```bash
# Install to /opt/babylink
sudo mkdir -p /opt/babylink
sudo cp -r . /opt/babylink/
cd /opt/babylink

# Install dependencies
sudo npm ci --only=production

# Create environment file
sudo cp .env.example .env
sudo nano .env  # Edit configuration

# Create systemd service
sudo cp deployment/babylink.service /etc/systemd/system/
sudo systemctl enable babylink
sudo systemctl start babylink
```

### 4. Start Services

```bash
# Copy Caddyfile
sudo cp Caddyfile /etc/caddy/Caddyfile

# Reload Caddy (automatic SSL with Let's Encrypt)
sudo systemctl reload caddy
```

**✅ Done!** Caddy automatically obtains and renews SSL certificates.

For detailed deployment instructions, see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 🏗️ Architecture

### Technology Stack

- **Backend:** Node.js + Express
- **Real-time:** Socket.IO (signaling)
- **WebRTC:** Browser native APIs (peer-to-peer audio)
- **Security:** Helmet.js, express-rate-limit, CORS
- **Logging:** Winston
- **Configuration:** dotenv

### Data Flow

```
Baby Device → WebRTC (P2P) → Parent Device(s)
     ↓                              ↓
Socket.IO ← BabyLink Server → Socket.IO
(Signaling only)
```

### Multi-Stream Architecture

- **Mesh Network:** Each baby establishes P2P connection with each parent
- **Scalable:** Supports up to 5 babies × 10 parents per room
- **Efficient:** Audio streams directly between devices (not through server)

---

## 🎨 Voice Activity Detection

BabyLink automatically detects baby sounds and manages audio:

| Level | Audio Range | Color | Behavior | Timeout |
|-------|-------------|-------|----------|---------|
| 🟢 **Quiet** | 0-30 | Green | Audio muted | - |
| 🟡 **Movement** | 31-80 | Yellow | Unmute after delay | 5 seconds |
| 🔴 **Crying** | 81-255 | Red | Immediate unmute | 10 seconds |

**Manual Override:** Parents can manually mute/unmute any baby at any time.

---

## 🔐 Security Best Practices

### Before Production

- [ ] Change `SESSION_SECRET` in `.env` to a secure random string
- [ ] Set appropriate `CORS_ORIGIN` (your domain, not `*`)
- [ ] Configure HTTPS with Caddy or Nginx
- [ ] Set `NODE_ENV=production`
- [ ] Review and adjust rate limiting settings
- [ ] Set up log rotation
- [ ] Enable firewall (allow 80, 443, SSH only)
- [ ] Keep dependencies updated (`npm audit`)

### SSL Certificates

**Never commit SSL certificates to the repository!**

- `.pem`, `.key`, `.crt`, `.cert` files are git-ignored
- Use Caddy for automatic Let's Encrypt SSL
- Certificates managed by reverse proxy, not application

---

## 📊 Monitoring

### Health Check

```bash
curl http://localhost:3001/health
```

**Response:**
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

**Application logs:**
```bash
tail -f logs/babylink.log
tail -f logs/error.log
```

**System service:**
```bash
sudo journalctl -u babylink -f
```

**Docker:**
```bash
docker-compose logs -f babylink
```

---

## 🐛 Troubleshooting

### WebRTC Connection Issues

**Symptom:** Audio not streaming between devices

**Solutions:**
1. Verify STUN server is accessible
2. Add TURN server for NAT traversal (see `.env.example`)
3. Check firewall allows UDP traffic
4. Test on same network first (eliminate network issues)

### Microphone Access Denied

**Symptom:** Baby device can't access microphone

**Solutions:**
1. Use HTTPS (required by browsers for getUserMedia)
2. Check browser permissions (camera/microphone)
3. Try different browser (Chrome/Safari recommended)

### Can't Access via HTTPS

**Solutions:**
1. Verify Caddy is running: `sudo systemctl status caddy`
2. Check DNS points to your server: `dig yourdomain.com`
3. Check firewall allows ports 80 and 443
4. View Caddy logs: `sudo journalctl -u caddy`

---

## 🧪 Development

### Project Structure

```
babylink/
├── server.js                # Main server file
├── config/
│   └── index.js            # Configuration management
├── middleware/
│   └── validation.js       # Input validation
├── utils/
│   └── logger.js           # Winston logging
├── public/
│   ├── js/
│   │   ├── multi-stream-manager.js  # WebRTC management
│   │   └── multi-baby-ui.js         # UI components
│   ├── client.js           # Legacy single-baby client
│   └── style.css
├── views/
│   ├── index.html          # Room creation/joining
│   ├── select-role.html    # Role selection with name input
│   ├── webrtc.html         # Multi-baby monitoring interface
│   └── webrtc-legacy.html  # Legacy single-baby interface
├── Dockerfile
├── docker-compose.yaml
├── Caddyfile              # Production Caddy config
├── Caddyfile.local        # Local HTTPS Caddy config
├── package.json
├── .env.example
└── .gitignore
```

### Running Tests

```bash
# Coming soon
npm test
```

### Code Style

- ES6+ JavaScript
- Modular design
- Structured logging
- Error handling with try-catch
- Input validation on all endpoints

---

## 📝 API Endpoints

### HTTP Endpoints

```
GET  /                    # Home page (room creation)
GET  /:roomId            # Room page (role selection or monitoring)
POST /:roomId            # Join room with role
GET  /health             # Health check endpoint
GET  /api/config/webrtc  # Get WebRTC configuration
```

### Socket.IO Events

**Client → Server:**
- `join` - Join a room with role and name
- `signal` - WebRTC signaling (offer/answer/ICE)

**Server → Client:**
- `room-state` - Current room participants
- `participant-joined` - New participant joined
- `participant-left` - Participant disconnected
- `signal` - WebRTC signaling relay
- `error` - Error message

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📜 License

This project is licensed under the **BSD-3-Clause License** - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- WebRTC for peer-to-peer audio streaming
- Socket.IO for real-time communication
- Caddy for automatic HTTPS
- Node.js and Express ecosystem

---

## 📧 Support

For issues or questions:

- 🐛 [GitHub Issues](https://github.com/yourusername/babylink/issues)
- 📖 [Documentation](DEPLOYMENT.md)
- 💬 Check application logs for errors

---

## 🗺️ Roadmap

- [ ] Audio recording functionality
- [ ] Push notifications for crying alerts
- [ ] Video streaming support
- [ ] Mobile app (React Native)
- [ ] Redis integration for horizontal scaling
- [ ] Automated tests (Jest + Playwright)
- [ ] Admin dashboard
- [ ] Usage analytics
- [ ] Dark mode UI

---

**Made with ❤️ for parents everywhere**
