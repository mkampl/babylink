// server.js - BabyLink HTTP Server
// For production, use a reverse proxy (Caddy/Nginx/Traefik) for SSL termination

const express = require('express');
const http = require('http');
const path = require('path');
// body-parser replaced with express built-in middleware
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

// Load configuration and utilities
const config = require('./config');
const logger = require('./utils/logger');
const { validateRoomId, validateRole, validateSocketJoinData } = require('./middleware/validation');
const ESP32AudioProxy = require('./server/esp32-proxy');
const roomConfig = require('./server/room-config');
const notificationService = require('./server/notification-service');

/**
 * Create and configure the BabyLink server.
 * Returns all server components without starting the listener.
 */
function createServer() {

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.security.corsOrigin,
    credentials: config.security.corsCredentials
  }
});

// Track rooms and their participants
const rooms = new Map();

// Track intervals for cleanup in tests
const intervals = [];

// Initialize ESP32 Audio Proxy
const esp32Proxy = new ESP32AudioProxy(io);
esp32Proxy.createWebSocketServer();

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for WebRTC
  crossOriginEmbedderPolicy: false // Needed for some WebRTC scenarios
}));

// CORS middleware
app.use(cors({
  origin: config.security.corsOrigin,
  credentials: config.security.corsCredentials
}));

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: config.security.rateLimitWindow,
  max: config.security.rateLimitMaxRequests,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, url: req.url });
    res.status(429).json({
      error: 'Too many requests, please try again later.'
    });
  }
});

// Apply rate limiting to all routes
app.use(limiter);

// Body parsing middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files middleware
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
  logger.logRequest(req, `${req.method} ${req.url}`);
  next();
});

// =============================================================================
// ROUTES
// =============================================================================

// Home page - Room creation/joining
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Health check endpoint
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

// ESP32 status endpoint
app.get('/api/esp32/status', (req, res) => {
  const stats = esp32Proxy.getStatistics();
  res.json(stats);
});

// API endpoint to get WebRTC configuration
app.get('/api/config/webrtc', (req, res) => {
  res.json(config.webrtcWithTurn);
});

// =============================================================================
// NOTIFICATION API ENDPOINTS
// =============================================================================

// Get room configuration including ntfy settings
app.get('/api/rooms/:roomId/config', validateRoomId, (req, res) => {
  const { roomId } = req.params;
  const roomConfiguration = roomConfig.getConfig(roomId);

  res.json({
    roomId,
    ...roomConfiguration
  });
});

// Set ntfy.sh topic for a room
app.post('/api/rooms/:roomId/ntfy', validateRoomId, async (req, res) => {
  const { roomId } = req.params;
  const { topic, ntfyServer, enabled = true, notifyOnCrying = true, notifyOnDisconnect = true, notifyOnActivity = false } = req.body;

  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Topic is required and must be a string' });
  }

  try {
    const updated = await roomConfig.updateConfig(roomId, {
      ntfyTopic: topic,
      ntfyServer: ntfyServer || null,
      ntfyEnabled: enabled,
      notifyOnCrying,
      notifyOnDisconnect,
      notifyOnActivity
    });

    logger.info(`ntfy.sh configured for room ${roomId}: topic=${topic}, enabled=${enabled}`);

    res.json({
      success: true,
      message: 'ntfy.sh notifications configured',
      config: updated
    });
  } catch (error) {
    logger.error(`Failed to configure ntfy for room ${roomId}:`, error);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Update ntfy settings for a room
app.patch('/api/rooms/:roomId/ntfy', validateRoomId, async (req, res) => {
  const { roomId } = req.params;
  const updates = req.body;

  try {
    const updated = await roomConfig.updateConfig(roomId, updates);

    logger.info(`ntfy.sh settings updated for room ${roomId}`);

    res.json({
      success: true,
      message: 'ntfy.sh settings updated',
      config: updated
    });
  } catch (error) {
    logger.error(`Failed to update ntfy settings for room ${roomId}:`, error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Disable ntfy notifications for a room
app.delete('/api/rooms/:roomId/ntfy', validateRoomId, async (req, res) => {
  const { roomId } = req.params;

  try {
    await roomConfig.updateConfig(roomId, {
      ntfyEnabled: false
    });

    logger.info(`ntfy.sh notifications disabled for room ${roomId}`);

    res.json({
      success: true,
      message: 'ntfy.sh notifications disabled'
    });
  } catch (error) {
    logger.error(`Failed to disable ntfy for room ${roomId}:`, error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Test notification endpoint (for debugging)
app.post('/api/rooms/:roomId/ntfy/test', validateRoomId, async (req, res) => {
  const { roomId } = req.params;
  const config = roomConfig.getConfig(roomId);
  const topic = config.ntfyEnabled ? config.ntfyTopic : null;

  if (!topic) {
    return res.status(400).json({ error: 'No ntfy.sh topic configured for this room' });
  }

  try {
    // Use per-room ntfy server if configured
    const originalServer = notificationService.ntfyServer;
    if (config.ntfyServer) {
      notificationService.ntfyServer = config.ntfyServer;
    }

    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const success = await notificationService.sendNotification(
      topic,
      'Test Notification',
      'This is a test notification from BabyLink',
      {
        priority: 'default',
        tags: ['test', 'baby'],
        click: `${serverUrl}/${roomId}?role=parent`
      }
    );

    notificationService.ntfyServer = originalServer;

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

// Check if a room has a PIN set
app.get('/api/rooms/:roomId/pin', validateRoomId, (req, res) => {
  const { roomId } = req.params;
  res.json({ hasPin: roomConfig.hasPin(roomId) });
});

// Set or remove a PIN for a room
app.post('/api/rooms/:roomId/pin', validateRoomId, async (req, res) => {
  const { roomId } = req.params;
  const { pin, currentPin } = req.body;

  // If room already has a PIN, require current PIN to change it
  if (roomConfig.hasPin(roomId)) {
    if (!roomConfig.verifyPin(roomId, currentPin)) {
      return res.status(403).json({ error: 'Current PIN is incorrect' });
    }
  }

  if (pin === null || pin === '') {
    await roomConfig.setPin(roomId, null);
    logger.info(`PIN removed for room ${roomId}`);
    return res.json({ success: true, message: 'PIN removed', hasPin: false });
  }

  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  }

  await roomConfig.setPin(roomId, pin);
  logger.info(`PIN set for room ${roomId}`);
  res.json({ success: true, message: 'PIN set', hasPin: true });
});

// Verify a PIN for a room
app.post('/api/rooms/:roomId/pin/verify', validateRoomId, (req, res) => {
  const { roomId } = req.params;
  const { pin } = req.body;

  if (!roomConfig.hasPin(roomId)) {
    return res.json({ valid: true, hasPin: false });
  }

  const valid = roomConfig.verifyPin(roomId, pin);
  res.json({ valid, hasPin: true });
});

// Room route with validation
app.get('/:roomId', validateRoomId, validateRole, (req, res) => {
  const { role } = req.query;

  if (role === 'baby' || role === 'parent') {
    // Disable caching for webrtc.html to ensure users get latest version
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'views', 'webrtc.html'));
  } else {
    res.sendFile(path.join(__dirname, 'views', 'select-role.html'));
  }
});

// Room role selection (POST)
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

  // Handle room join
  socket.on('join', (data) => {
    try {
      // Validate join data
      const validation = validateSocketJoinData(data);
      if (!validation.isValid) {
        logger.warn('Invalid join data', { socketId: socket.id, errors: validation.errors });
        socket.emit('error', { message: validation.errors.join(', ') });
        return;
      }

      const { roomId, role, userName, pin } = data;

      // Verify PIN if room has one set
      if (roomConfig.hasPin(roomId) && !roomConfig.verifyPin(roomId, pin)) {
        socket.emit('error', { message: 'Invalid room PIN', code: 'INVALID_PIN' });
        return;
      }

      // Join the room
      socket.join(roomId);
      socket.roomId = roomId;
      socket.role = role;
      socket.userName = userName || role;

      // Initialize room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          participants: [],
          createdAt: new Date().toISOString()
        });
        logger.logRoomEvent(roomId, 'room-created', { role });
      }

      const room = rooms.get(roomId);

      // Check room capacity
      const roleCount = room.participants.filter(p => p.role === role).length;
      const maxCapacity = role === 'baby' ? config.room.maxBabiesPerRoom : config.room.maxParentsPerRoom;

      if (roleCount >= maxCapacity) {
        logger.warn('Room capacity exceeded', { roomId, role, current: roleCount, max: maxCapacity });
        socket.emit('error', { message: `Room is full (max ${maxCapacity} ${role}s)` });
        return;
      }

      // Remove any existing entry for this socket (reconnection)
      room.participants = room.participants.filter(p => p.socketId !== socket.id);

      // Add current participant
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

      // Get all participants including ESP32 devices
      const allParticipants = esp32Proxy.getRoomParticipants(roomId);

      // Notify all participants in the room about the new joiner
      socket.to(roomId).emit('participant-joined', {
        role,
        userName: socket.userName,
        socketId: socket.id,
        participants: allParticipants
      });

      // Send current participants to the new joiner
      socket.emit('room-state', {
        participants: allParticipants
      });

    } catch (error) {
      logger.error('Error in join handler', { error: error.message, socketId: socket.id });
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Handle WebRTC signaling
  socket.on('signal', (data) => {
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

      // If 'to' is specified, send to that specific socket
      if (data.to) {
        io.to(data.to).emit('signal', {
          ...data,
          from: socket.role,
          fromSocketId: socket.id,
          fromUserName: socket.userName
        });
        logger.debug(`Signal routed to specific participant: ${data.to}`);
      } else {
        // Otherwise broadcast to all participants in the room (legacy behavior)
        socket.to(socket.roomId).emit('signal', {
          ...data,
          from: socket.role,
          fromSocketId: socket.id,
          fromUserName: socket.userName
        });
        logger.debug('Signal broadcast to all room participants');
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
          // Remove participant
          room.participants = room.participants.filter(p => p.socketId !== socket.id);

          logger.logRoomEvent(socket.roomId, 'participant-left', {
            socketId: socket.id,
            role: socket.role,
            remainingParticipants: room.participants.length
          });

          // Notify remaining participants
          socket.to(socket.roomId).emit('participant-left', {
            role: socket.role,
            socketId: socket.id,
            userName: socket.userName,
            participants: room.participants
          });

          // Send ntfy disconnect notification if baby device disconnects
          if (socket.role === 'baby') {
            try {
              const config = roomConfig.getConfig(socket.roomId);
              if (config.ntfyEnabled && config.ntfyTopic && config.notifyOnDisconnect) {
                const ntfyServer = config.ntfyServer || notificationService.ntfyServer;
                const originalServer = notificationService.ntfyServer;
                notificationService.ntfyServer = ntfyServer;
                notificationService.sendDisconnectAlert(config.ntfyTopic, socket.roomId, socket.userName || 'Baby');
                notificationService.ntfyServer = originalServer;
              }
            } catch (ntfyErr) {
              logger.error('Failed to send disconnect notification', { error: ntfyErr.message });
            }
          }

          // Clean up empty rooms
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

  // Handle crying detection — send ntfy.sh notification
  socket.on('crying-detected', async (data) => {
    try {
      if (!socket.roomId) return;
      const { babyName } = data;
      const config = roomConfig.getConfig(socket.roomId);

      if (!config.ntfyEnabled || !config.ntfyTopic || !config.notifyOnCrying) {
        return;
      }

      const ntfyServer = config.ntfyServer || notificationService.ntfyServer;
      const originalServer = notificationService.ntfyServer;
      notificationService.ntfyServer = ntfyServer;

      await notificationService.sendCryingAlert(
        config.ntfyTopic,
        socket.roomId,
        babyName || 'Baby',
        null
      );

      notificationService.ntfyServer = originalServer;
    } catch (error) {
      logger.error('Error in crying-detected handler', { error: error.message, socketId: socket.id });
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    logger.error('Socket error', { socketId: socket.id, error: error.message });
  });
});

// =============================================================================
// CLEANUP & MONITORING
// =============================================================================

// Periodic room cleanup (remove stale rooms)
intervals.push(setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [roomId, room] of rooms.entries()) {
    // Remove rooms with no participants that are older than cleanup interval
    if (room.participants.length === 0) {
      const roomAge = now - new Date(room.createdAt).getTime();
      if (roomAge > config.room.cleanupInterval) {
        rooms.delete(roomId);
        cleanedCount++;
        logger.logRoomEvent(roomId, 'room-cleaned', { age: roomAge });
      }
    }
  }

  if (cleanedCount > 0) {
    logger.info(`Cleaned up ${cleanedCount} stale rooms`);
  }
}, config.room.cleanupInterval));

// Log room statistics periodically
intervals.push(setInterval(() => {
  const stats = {
    totalRooms: rooms.size,
    totalParticipants: Array.from(rooms.values()).reduce((sum, room) => sum + room.participants.length, 0)
  };
  logger.info('Room statistics', stats);
}, 300000)); // Every 5 minutes

// =============================================================================
// ESP32 WEBSOCKET UPGRADE HANDLER
// =============================================================================

// Handle WebSocket upgrade for ESP32 devices
// Only intercept /esp32-baby path; let Socket.IO handle its own upgrades
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/esp32-baby') {
    logger.info(`ESP32 WebSocket upgrade request from ${socket.remoteAddress}`);
    esp32Proxy.handleUpgrade(request, socket, head);
  }
  // Other paths (e.g., /socket.io/) are handled by Socket.IO automatically
});

// Return all server components for testing and startup
return { app, server, io, rooms, esp32Proxy, intervals };

} // end createServer()

// =============================================================================
// SERVER STARTUP (only when run directly)
// =============================================================================

if (require.main === module) {
  const { server, intervals } = createServer();

  // Graceful shutdown
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

  // Load room configurations then start server
  roomConfig.load().then(() => {
  server.listen(config.server.port, () => {
    logger.info(`BabyLink HTTP Server running at http://localhost:${config.server.port}`);
    logger.info(`Environment: ${config.server.nodeEnv}`);
    logger.info(`Use a reverse proxy (Caddy/Nginx) for HTTPS in production`);
    logger.info(`Multi-baby mode: ${config.features.multiBaby ? 'Enabled' : 'Disabled'}`);

    if (config.server.isDevelopment) {
      logger.debug('Configuration loaded', {
        port: config.server.port,
        maxRooms: config.room.maxRooms,
        maxBabiesPerRoom: config.room.maxBabiesPerRoom,
        maxParentsPerRoom: config.room.maxParentsPerRoom,
        logLevel: config.logging.level
      });
    }
  });
  });
}

module.exports = { createServer };
