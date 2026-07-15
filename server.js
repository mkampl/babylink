// server.js - BabyLink HTTP Server
// For production, use a reverse proxy (Caddy/Nginx/Traefik) for SSL termination

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

// Load configuration and utilities
const config = require('./config');
const logger = require('./utils/logger');
const { validateRoomId, validateRole, validateSocketJoinData, sanitizeInput } = require('./middleware/validation');
const ESP32AudioProxy = require('./server/esp32-proxy');
const roomConfig = require('./server/room-config');
const notificationService = require('./server/notification-service');
const { validateNtfyTopic, validateNtfyServer } = require('./server/notification-service');

// =============================================================================
// OWNER AUTH MIDDLEWARE
// =============================================================================

/**
 * Verify the Authorization: Bearer <ownerToken> header against the stored
 * SHA-256 hash for this room.
 *
 * Responses:
 *   401 – no header or wrong token
 *   403 – room exists but was not created via POST /api/rooms (no owner)
 *   next() – token is valid
 */
function requireOwnerAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required: Bearer <ownerToken>' });
  }

  const token = authHeader.slice(7);
  const { roomId } = req.params;

  const result = roomConfig.verifyOwnerToken(roomId, token);

  if (result === 'no-owner') {
    return res.status(403).json({
      error: 'Room not manageable: create the room via POST /api/rooms first'
    });
  }
  if (result === 'invalid') {
    return res.status(401).json({ error: 'Invalid authorization token' });
  }

  next();
}

// =============================================================================
// SOCKET RATE LIMITING HELPERS
// =============================================================================

/**
 * Per-socket event rate limiter. Returns a function that can be called before
 * handling an event; returns true if the event is allowed.
 *
 * @param {number} max  - max events per window
 * @param {number} windowMs - rolling window length in ms
 */
function makeSocketRateLimiter(max, windowMs) {
  return function allowed(socket, eventName) {
    const key = `rl:${eventName}`;
    if (!socket[key]) socket[key] = { count: 0, start: Date.now() };
    const rl = socket[key];
    const now = Date.now();
    if (now - rl.start > windowMs) { rl.count = 0; rl.start = now; }
    rl.count++;
    return rl.count <= max;
  };
}

// join: 10 per 10 s (avoid room-scan abuse)
const joinRateOk = makeSocketRateLimiter(10, 10_000);
// signal: 200 per 10 s (WebRTC negotiation bursts can be large)
const signalRateOk = makeSocketRateLimiter(200, 10_000);
// crying-detected: 5 per 10 s (client-side detection can fire rapidly)
const cryingRateOk = makeSocketRateLimiter(5, 10_000);

// =============================================================================
// PIN LOCKOUT STATE
// =============================================================================

// key: `${roomId}:${ip}` → { failures, lockedUntil }
const pinLockout = new Map();
const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_BASE_MS = 30_000; // 30 s base, doubles per failure beyond threshold

function getPinLockout(roomId, ip) {
  return pinLockout.get(`${roomId}:${ip}`) || { failures: 0, lockedUntil: 0 };
}

function recordPinFailure(roomId, ip) {
  const key = `${roomId}:${ip}`;
  const state = getPinLockout(roomId, ip);
  state.failures++;
  if (state.failures >= PIN_MAX_FAILURES) {
    const extra = state.failures - PIN_MAX_FAILURES;
    state.lockedUntil = Date.now() + PIN_LOCKOUT_BASE_MS * Math.pow(2, extra);
  }
  pinLockout.set(key, state);
}

function clearPinLockout(roomId, ip) {
  pinLockout.delete(`${roomId}:${ip}`);
}

function isPinLocked(roomId, ip) {
  const state = getPinLockout(roomId, ip);
  return state.lockedUntil > Date.now();
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create and configure the BabyLink server.
 * Returns all server components without starting the listener.
 */
// Real client IP for a socket. socket.handshake.address is the DIRECT peer,
// which behind the deployed Caddy reverse proxy is the loopback/proxy address
// — identical for every client, so the per-IP socket cap would act globally
// and a room's PIN lockout would lock out everyone. Caddy sets
// `X-Forwarded-For {remote_host}` (a single, trusted entry it overwrites, so
// it can't be spoofed by the client), matching Express's `trust proxy 1`.
// Fall back to the direct address for direct/LAN/dev access with no proxy.
function socketClientIp(socket) {
  const xff = socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return socket.handshake.address || 'unknown';
}

function createServer() {

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.security.corsOrigin,
    credentials: config.security.corsCredentials
  }
});

// Trust the first proxy hop so rate limiters key on the real client IP
// when running behind Caddy / nginx (not the loopback address).
app.set('trust proxy', 1);

// Track rooms and their participants
const rooms = new Map();

// Per-IP socket connection tracking (anti-DoS)
const socketIpCount = new Map();

// Track intervals for cleanup in tests
const intervals = [];

// Initialize ESP32 Audio Proxy
const esp32Proxy = new ESP32AudioProxy(io);
esp32Proxy.createWebSocketServer();

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Security middleware — enable a tailored CSP that still allows WebRTC
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      // WebRTC: allow wss: and STUN/TURN connections
      connectSrc: [
        "'self'",
        'wss:',
        'ws:',
        'stun:',
        'turn:',
      ],
      fontSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Needed for some WebRTC scenarios
}));

// CORS middleware
app.use(cors({
  origin: config.security.corsOrigin,
  credentials: config.security.corsCredentials
}));

// Rate limit dynamic routes only
const limiter = rateLimit({
  windowMs: config.security.rateLimitWindow,
  max: config.security.rateLimitMaxRequests,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.method !== 'GET') return false;
    const p = req.path;
    return p.startsWith('/css/') ||
           p.startsWith('/js/') ||
           p.startsWith('/icons/') ||
           p === '/manifest.json' ||
           p === '/service-worker.js' ||
           p === '/health';
  },
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, url: req.url });
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
});

// Stricter limiter for PIN verify (brute-force target)
const pinVerifyLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 10,
  message: 'Too many PIN attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  logger.logRequest(req, `${req.method} ${req.url}`);
  next();
});

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Health check — aggregate counts only, no PII
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    esp32Devices: esp32Proxy.esp32Clients.size,
    version: require('./package.json').version
  });
});

// ESP32 aggregate status — no room IDs, device IDs, or IPs (H4)
app.get('/api/esp32/status', (req, res) => {
  res.json(esp32Proxy.getStatistics());
});

// WebRTC ICE server configuration (public)
app.get('/api/config/webrtc', (req, res) => {
  res.json(config.webrtcWithTurn);
});

// LAN address hint for the BLE wizard
app.get('/api/config/server-hint', (req, res) => {
  let host = process.env.PUBLIC_HOST;
  if (!host) {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let lanIp = null;
    for (const name of Object.keys(interfaces)) {
      for (const addr of interfaces[name]) {
        if (addr.family === 'IPv4' && !addr.internal) {
          if (addr.address.startsWith('192.168.') || addr.address.startsWith('10.')) {
            lanIp = addr.address;
            break;
          }
          if (!lanIp) lanIp = addr.address;
        }
      }
      if (lanIp && (lanIp.startsWith('192.168.') || lanIp.startsWith('10.'))) break;
    }
    host = lanIp || req.hostname;
  }
  res.json({
    host,
    port: parseInt(process.env.PUBLIC_PORT || process.env.PORT, 10) || 3001
  });
});

// =============================================================================
// ROOM CREATION (Contract: POST /api/rooms)
// =============================================================================

/**
 * POST /api/rooms
 * Create a new room with a stable owner token.
 *
 * Body (optional): { "name": string }
 * Response 201: { "roomId": "<32-hex>", "ownerToken": "<64-hex>" }
 * Response 429: server at capacity
 */
app.post('/api/rooms', async (req, res) => {
  // Enforce maxRooms cap on persisted configs
  if (roomConfig.configs.size >= config.room.maxRooms) {
    logger.warn('Room limit reached', { current: roomConfig.configs.size, max: config.room.maxRooms });
    return res.status(429).json({ error: 'Room limit reached. Try again later.' });
  }

  const roomId = crypto.randomBytes(16).toString('hex');      // 32-hex
  const ownerToken = crypto.randomBytes(32).toString('hex'); // 64-hex

  try {
    await roomConfig.setOwnerToken(roomId, ownerToken);
    logger.info(`Room created: ${roomId}`);
    return res.status(201).json({ roomId, ownerToken });
  } catch (err) {
    logger.error('Failed to create room', { error: err.message });
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

// =============================================================================
// ESP32 DEVICE MANAGEMENT ENDPOINTS (owner-authenticated)
// =============================================================================

// List ESP32 devices in a room (owner only)
app.get('/api/rooms/:roomId/esp32/devices', validateRoomId, requireOwnerAuth, (req, res) => {
  const devices = esp32Proxy.getDevicesForRoom(req.params.roomId);
  res.json({ devices });
});

// Rename an ESP32 device (owner only)
app.patch('/api/rooms/:roomId/esp32/:esp32Id', validateRoomId, requireOwnerAuth, (req, res) => {
  const { roomId, esp32Id } = req.params;
  const name = sanitizeInput(req.body.name);

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const client = esp32Proxy.esp32Clients.get(esp32Id);
  if (!client || client.roomId !== roomId) {
    return res.status(404).json({ error: 'Device not found in this room' });
  }

  const result = esp32Proxy.renameDevice(esp32Id, name.trim());
  res.json({ success: true, device: result });
});

// Force disconnect an ESP32 device (owner only)
app.delete('/api/rooms/:roomId/esp32/:esp32Id', validateRoomId, requireOwnerAuth, (req, res) => {
  const { roomId, esp32Id } = req.params;

  const client = esp32Proxy.esp32Clients.get(esp32Id);
  if (!client || client.roomId !== roomId) {
    return res.status(404).json({ error: 'Device not found in this room' });
  }

  esp32Proxy.forceDisconnect(esp32Id);
  res.json({ success: true, message: 'Device disconnected' });
});

// Factory-reset an ESP32 device (owner only)
app.post('/api/rooms/:roomId/esp32/:esp32Id/reset', validateRoomId, requireOwnerAuth, (req, res) => {
  const { roomId, esp32Id } = req.params;

  const client = esp32Proxy.esp32Clients.get(esp32Id);
  if (!client || client.roomId !== roomId) {
    return res.status(404).json({ error: 'Device not found in this room' });
  }

  const ok = esp32Proxy.sendFactoryReset(esp32Id);
  if (!ok) return res.status(500).json({ error: 'Failed to send reset command' });

  res.json({ success: true, message: 'Reset command sent; device will reboot into provisioning mode' });
});

// =============================================================================
// NOTIFICATION API ENDPOINTS (owner-authenticated mutations)
// =============================================================================

/**
 * GET /api/rooms/:roomId/config
 * Public — returns only non-sensitive fields.
 * NEVER returns pin hash/salt, ntfy topic, or ntfy server URL.
 */
app.get('/api/rooms/:roomId/config', validateRoomId, (req, res) => {
  const { roomId } = req.params;
  const cfg = roomConfig.getConfig(roomId);
  res.json({
    hasPin: roomConfig.hasPin(roomId),
    ntfyEnabled: cfg.ntfyEnabled,
  });
});

// Read ntfy.sh settings for a room (owner only) — used to pre-fill the settings panel
app.get('/api/rooms/:roomId/ntfy', validateRoomId, requireOwnerAuth, (req, res) => {
  const cfg = roomConfig.getConfig(req.params.roomId) || {};
  res.json({
    ntfyServer: cfg.ntfyServer || null,
    ntfyTopic: cfg.ntfyTopic || null,
    ntfyEnabled: cfg.ntfyEnabled === true,
    notifyOnCrying: cfg.notifyOnCrying !== false,
    notifyOnDisconnect: cfg.notifyOnDisconnect !== false,
    notifyOnActivity: cfg.notifyOnActivity === true
  });
});

// Set ntfy.sh topic for a room (owner only)
app.post('/api/rooms/:roomId/ntfy', validateRoomId, requireOwnerAuth, async (req, res) => {
  const { roomId } = req.params;
  const {
    topic,
    ntfyServer,
    enabled = true,
    notifyOnCrying = true,
    notifyOnDisconnect = true,
    notifyOnActivity = false
  } = req.body;

  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Topic is required and must be a string' });
  }

  const topicErr = validateNtfyTopic(topic);
  if (topicErr) return res.status(400).json({ error: topicErr });

  const serverErr = validateNtfyServer(ntfyServer || null, notificationService.allowedHosts);
  if (serverErr) return res.status(400).json({ error: serverErr });

  try {
    await roomConfig.updateConfig(roomId, {
      ntfyTopic: topic,
      ntfyServer: ntfyServer || null,
      ntfyEnabled: enabled,
      notifyOnCrying,
      notifyOnDisconnect,
      notifyOnActivity
    });

    logger.info(`ntfy configured for room ${roomId}: topic=${topic}, enabled=${enabled}`);
    res.json({ success: true, message: 'ntfy.sh notifications configured' });
  } catch (error) {
    logger.error(`Failed to configure ntfy for room ${roomId}:`, error);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Test notification endpoint (owner only)
app.post('/api/rooms/:roomId/ntfy/test', validateRoomId, requireOwnerAuth, async (req, res) => {
  const { roomId } = req.params;
  const cfg = roomConfig.getConfig(roomId);

  if (!cfg.ntfyEnabled || !cfg.ntfyTopic) {
    return res.status(400).json({ error: 'No ntfy.sh topic configured for this room' });
  }

  try {
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const success = await notificationService.sendNotification(
      cfg.ntfyTopic,
      'Test Notification',
      'This is a test notification from BabyLink',
      {
        priority: 'default',
        tags: ['test', 'baby'],
        click: `${serverUrl}/${roomId}?role=parent`
      },
      cfg.ntfyServer || null
    );

    res.json({
      success,
      message: success ? 'Test notification sent' : 'Failed to send notification'
    });
  } catch (error) {
    logger.error(`Failed to send test notification for room ${roomId}:`, error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// =============================================================================
// ROOM PIN ENDPOINTS
// =============================================================================

/**
 * GET /api/rooms/:roomId/pin — public: does a PIN exist?
 */
app.get('/api/rooms/:roomId/pin', validateRoomId, (req, res) => {
  res.json({ hasPin: roomConfig.hasPin(req.params.roomId) });
});

/**
 * POST /api/rooms/:roomId/pin — owner only: set or remove PIN.
 * Minimum PIN length is 6 digits.
 */
app.post('/api/rooms/:roomId/pin', validateRoomId, requireOwnerAuth, async (req, res) => {
  const { roomId } = req.params;
  const { pin } = req.body;

  if (pin === null || pin === '') {
    await roomConfig.setPin(roomId, null);
    logger.info(`PIN removed for room ${roomId}`);
    return res.json({ success: true, message: 'PIN removed', hasPin: false });
  }

  if (typeof pin !== 'string' || pin.length < 6 || pin.length > 8 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 6–8 digits' });
  }

  await roomConfig.setPin(roomId, pin);
  logger.info(`PIN set for room ${roomId}`);
  res.json({ success: true, message: 'PIN set', hasPin: true });
});

/**
 * POST /api/rooms/:roomId/pin/verify — public with rate limiting + lockout.
 * Does NOT require owner auth (parents need to verify without owning the room).
 */
app.post('/api/rooms/:roomId/pin/verify', validateRoomId, pinVerifyLimiter, (req, res) => {
  const { roomId } = req.params;
  const { pin } = req.body;
  const ip = req.ip || 'unknown';

  if (!roomConfig.hasPin(roomId)) {
    return res.json({ valid: true, hasPin: false });
  }

  if (isPinLocked(roomId, ip)) {
    return res.status(429).json({
      valid: false,
      hasPin: true,
      error: 'Too many failed attempts. Please wait before trying again.'
    });
  }

  const valid = roomConfig.verifyPin(roomId, pin);
  if (valid) {
    clearPinLockout(roomId, ip);
    return res.json({ valid: true, hasPin: true });
  }

  recordPinFailure(roomId, ip);
  res.json({ valid: false, hasPin: true });
});

// =============================================================================
// ROOM ROUTES
// =============================================================================

app.get('/:roomId', validateRoomId, validateRole, (req, res) => {
  const { role } = req.query;
  if (role === 'baby' || role === 'parent') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'views', 'webrtc.html'));
  } else {
    res.sendFile(path.join(__dirname, 'views', 'select-role.html'));
  }
});

app.post('/:roomId', validateRoomId, (req, res) => {
  const { roomId } = req.params;
  const { role } = req.body;

  if (!role || !config.validation.isValidRole(role)) {
    logger.warn('Invalid role in POST request', { roomId, role });
    return res.status(400).json({ error: 'Invalid role' });
  }

  res.redirect(`/${encodeURIComponent(roomId)}?role=${encodeURIComponent(role)}`);
});

// 404 handler
app.use((req, res) => {
  logger.warn('404 Not Found', { url: req.url });
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Server error', { error: err.message, stack: err.stack, url: req.url });
  res.status(500).json({
    error: config.server.isDevelopment ? err.message : 'Internal server error'
  });
});

// =============================================================================
// SOCKET.IO CONNECTION HANDLING
// =============================================================================

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Per-IP socket connection cap (real client IP, not the proxy's — see
  // socketClientIp). Used for both the cap and the room PIN lockout below.
  const clientIp = socketClientIp(socket);
  const ipSockCount = (socketIpCount.get(clientIp) || 0) + 1;
  if (ipSockCount > config.room.maxSocketsPerIp) {
    logger.warn(`Socket rejected: IP ${clientIp} at connection cap`);
    socket.emit('error', { message: 'Connection limit reached', code: 'CONN_LIMIT' });
    socket.disconnect(true);
    return;
  }
  socketIpCount.set(clientIp, ipSockCount);

  socket.on('disconnect', () => {
    const remaining = (socketIpCount.get(clientIp) || 1) - 1;
    if (remaining <= 0) socketIpCount.delete(clientIp);
    else socketIpCount.set(clientIp, remaining);
  });

  // Handle room join
  socket.on('join', async (data) => {
    if (!joinRateOk(socket, 'join')) {
      socket.emit('error', { message: 'Too many join attempts', code: 'RATE_LIMIT' });
      return;
    }

    try {
      const validation = validateSocketJoinData(data);
      if (!validation.isValid) {
        logger.warn('Invalid join data', { socketId: socket.id, errors: validation.errors });
        socket.emit('error', { message: validation.errors.join(', ') });
        return;
      }

      const { roomId, role, pin } = data;
      const userName = sanitizeInput(data.userName) || role;

      // maxRooms cap on lazy-created rooms
      if (!rooms.has(roomId) && rooms.size >= config.room.maxRooms) {
        socket.emit('error', { message: 'Server at capacity', code: 'ROOM_LIMIT' });
        return;
      }

      // PIN verification with lockout
      if (roomConfig.hasPin(roomId)) {
        const ip = clientIp;

        if (isPinLocked(roomId, ip)) {
          socket.emit('error', { message: 'Too many failed PIN attempts. Please wait.', code: 'PIN_LOCKED' });
          return;
        }

        if (!roomConfig.verifyPin(roomId, pin)) {
          recordPinFailure(roomId, ip);
          socket.emit('error', { message: 'Invalid room PIN', code: 'INVALID_PIN' });
          return;
        }

        clearPinLockout(roomId, ip);
      }

      socket.join(roomId);
      socket.roomId = roomId;
      socket.role = role;
      socket.userName = userName;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, { participants: [], createdAt: new Date().toISOString() });
        logger.logRoomEvent(roomId, 'room-created', { role });
      }

      const room = rooms.get(roomId);

      const roleCount = room.participants.filter(p => p.role === role).length;
      const maxCapacity = role === 'baby' ? config.room.maxBabiesPerRoom : config.room.maxParentsPerRoom;

      if (roleCount >= maxCapacity) {
        logger.warn('Room capacity exceeded', { roomId, role, current: roleCount, max: maxCapacity });
        socket.emit('error', { message: `Room is full (max ${maxCapacity} ${role}s)` });
        return;
      }

      room.participants = room.participants.filter(p => p.socketId !== socket.id);
      room.participants.push({
        socketId: socket.id,
        role,
        userName: socket.userName,
        joinedAt: new Date().toISOString()
      });

      logger.logRoomEvent(roomId, 'participant-joined', {
        socketId: socket.id,
        role,
        userName: socket.userName,
        totalParticipants: room.participants.length
      });

      const allParticipants = esp32Proxy.getRoomParticipants(roomId);

      socket.to(roomId).emit('participant-joined', {
        role,
        userName: socket.userName,
        socketId: socket.id,
        participants: allParticipants
      });

      socket.emit('room-state', { participants: allParticipants });

    } catch (error) {
      logger.error('Error in join handler', { error: error.message, socketId: socket.id });
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // A baby reports its own battery so the parent knows the monitored device
  // won't quietly die. Stored on the socket (so late-joining parents get it via
  // room-state, see getRoomParticipants) and relayed live to the room.
  socket.on('baby-status', (data) => {
    if (!socket.roomId || typeof data !== 'object' || data === null) return;
    const level = Number(data.battery);
    if (Number.isFinite(level)) socket.battery = Math.max(0, Math.min(100, Math.round(level)));
    socket.charging = !!data.charging;
    socket.to(socket.roomId).emit('baby-status', {
      socketId: socket.id,
      battery: socket.battery,
      charging: socket.charging
    });
  });

  // Handle WebRTC signaling
  socket.on('signal', (data) => {
    if (!signalRateOk(socket, 'signal')) {
      logger.warn('Signal rate limit exceeded', { socketId: socket.id });
      return;
    }

    try {
      if (!socket.roomId) {
        logger.warn('Signal from socket not in a room', { socketId: socket.id });
        return;
      }

      const signalType = data.offer ? 'offer' : data.answer ? 'answer' : data.ice ? 'ice' : 'unknown';
      logger.logSocketEvent('signal', socket.id, {
        type: signalType,
        from: socket.role,
        to: data.to,
        roomId: socket.roomId
      });

      if (data.to) {
        if (typeof data.to === 'string' && data.to.startsWith('esp32_')) {
          const ok = esp32Proxy.relaySignalToESP(data.to, data, socket.id, socket.userName);
          if (!ok) logger.warn(`Signal to ESP32 ${data.to} dropped — not connected`);
        } else {
          io.to(data.to).emit('signal', {
            ...data,
            from: socket.role,
            fromSocketId: socket.id,
            fromUserName: socket.userName
          });
        }
      } else {
        socket.to(socket.roomId).emit('signal', {
          ...data,
          from: socket.role,
          fromSocketId: socket.id,
          fromUserName: socket.userName
        });
      }

    } catch (error) {
      logger.error('Error in signal handler', { error: error.message, socketId: socket.id });
    }
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    logger.info('Client disconnected', { socketId: socket.id, reason });

    try {
      if (socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room) {
          room.participants = room.participants.filter(p => p.socketId !== socket.id);

          logger.logRoomEvent(socket.roomId, 'participant-left', {
            socketId: socket.id,
            role: socket.role,
            remainingParticipants: room.participants.length
          });

          socket.to(socket.roomId).emit('participant-left', {
            role: socket.role,
            socketId: socket.id,
            userName: socket.userName,
            participants: room.participants
          });

          if (socket.role === 'baby') {
            try {
              const cfg = roomConfig.getConfig(socket.roomId);
              if (cfg.ntfyEnabled && cfg.ntfyTopic && cfg.notifyOnDisconnect) {
                notificationService.sendDisconnectAlert(
                  cfg.ntfyTopic,
                  socket.roomId,
                  socket.userName || 'Baby',
                  cfg.ntfyServer || null
                );
              }
            } catch (ntfyErr) {
              logger.error('Failed to send disconnect notification', { error: ntfyErr.message });
            }
          }

          if (room.participants.length === 0) {
            rooms.delete(socket.roomId);
            logger.logRoomEvent(socket.roomId, 'room-deleted', { reason: 'empty' });
          }
        }
      }
    } catch (error) {
      logger.error('Error in disconnect handler', { error: error.message, socketId: socket.id });
    }
  });

  // Handle crying detection — sanitize babyName and enforce rate limit
  socket.on('crying-detected', async (data) => {
    if (!cryingRateOk(socket, 'crying-detected')) {
      logger.warn('crying-detected rate limit exceeded', { socketId: socket.id });
      return;
    }

    try {
      if (!socket.roomId) {
        logger.warn('crying-detected from socket not in room', { socketId: socket.id });
        return;
      }

      // Sanitize client-supplied name to prevent XSS in notifications
      const babyName = sanitizeInput(data && data.babyName) || 'Baby';

      logger.info('Crying detected', { roomId: socket.roomId, babyName, from: socket.role });

      const cfg = roomConfig.getConfig(socket.roomId);
      if (!cfg.ntfyEnabled || !cfg.ntfyTopic || !cfg.notifyOnCrying) return;

      await notificationService.sendCryingAlert(
        cfg.ntfyTopic,
        socket.roomId,
        babyName,
        null,
        cfg.ntfyServer || null
      );

    } catch (error) {
      logger.error('Error in crying-detected handler', { error: error.message, socketId: socket.id });
    }
  });

  socket.on('error', (error) => {
    logger.error('Socket error', { socketId: socket.id, error: error.message });
  });
});

// =============================================================================
// CLEANUP & MONITORING
// =============================================================================

intervals.push(setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) {
      const roomAge = now - new Date(room.createdAt).getTime();
      if (roomAge > config.room.cleanupInterval) {
        rooms.delete(roomId);
        cleanedCount++;
        logger.logRoomEvent(roomId, 'room-cleaned', { age: roomAge });
      }
    }
  }

  if (cleanedCount > 0) logger.info(`Cleaned up ${cleanedCount} stale rooms`);
}, config.room.cleanupInterval));

intervals.push(setInterval(() => {
  logger.info('Room statistics', {
    totalRooms: rooms.size,
    totalParticipants: Array.from(rooms.values()).reduce((s, r) => s + r.participants.length, 0)
  });
}, 300000));

// =============================================================================
// ESP32 WEBSOCKET UPGRADE HANDLER
// =============================================================================

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/esp32-baby') {
    logger.info(`ESP32 WebSocket upgrade request from ${socket.remoteAddress}`);
    esp32Proxy.handleUpgrade(request, socket, head);
  }
});

return { app, server, io, rooms, esp32Proxy, intervals };

} // end createServer()

// =============================================================================
// SERVER STARTUP (only when run directly)
// =============================================================================

if (require.main === module) {
  const { server, intervals } = createServer();

  const shutdown = () => {
    logger.info('Shutting down gracefully');
    intervals.forEach(id => clearInterval(id));
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  roomConfig.load().then(() => {
    server.listen(config.server.port, () => {
      logger.info(`BabyLink HTTP Server running at http://localhost:${config.server.port}`);
      logger.info(`Environment: ${config.server.nodeEnv}`);
      logger.info(`Use a reverse proxy (Caddy/Nginx) for HTTPS in production`);
      logger.info(`Multi-baby mode: ${config.features.multiBaby ? 'Enabled' : 'Disabled'}`);
    });
  });
}

module.exports = { createServer, socketClientIp };
