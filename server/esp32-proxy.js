// server/esp32-proxy.js
// WebSocket proxy for ESP32-S3 baby devices
//
// The proxy handles JSON control messages (register / ping / signal) only.
// Raw PCM audio is no longer forwarded by the server — the S3 firmware
// uses WebRTC directly for audio, and crying detection runs in the browser.
//
// Device-side authentication (token per device) is future work; today the
// server trusts the registration payload at face value. The mitigations in
// place are:
//   – per-IP connection cap (maxSocketsPerIp)
//   – per-IP message rate limit
//   – maxPayload on the WebSocket.Server
//   – all device management (rename/delete/reset) is gated behind owner auth
//     so a spoofed registration cannot be weaponised by a third party

const WebSocket = require('ws');
const logger = require('../utils/logger');
const roomConfig = require('./room-config');
const notificationService = require('./notification-service');

// Maximum WebSocket frame payload (64 KB). Control messages are tiny;
// a larger limit would let a single ESP32 frame exhaust server heap.
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Per-IP connection cap. All WS connections from one IP count together.
const MAX_CONNECTIONS_PER_IP = 10;

// Per-connection message rate limit: max N messages per window (ms)
const MSG_RATE_MAX = 60;
const MSG_RATE_WINDOW_MS = 10_000; // 10 seconds

class ESP32AudioProxy {
  constructor(io, opts = {}) {
    this.io = io;
    this.esp32Clients = new Map(); // esp32Id -> client info
    // User-applied renames keyed by ESP32 ID. Lives beyond the client's
    // connection so a device reboot keeps its label.
    this.deviceNames = new Map(); // esp32Id -> name
    this.wss = null;

    // Per-IP connection tracking
    this._ipConnections = new Map(); // ip -> count

    // Allow overriding limits in tests
    this._maxConnectionsPerIp = opts.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
    this._msgRateMax = opts.msgRateMax ?? MSG_RATE_MAX;
    this._msgRateWindowMs = opts.msgRateWindowMs ?? MSG_RATE_WINDOW_MS;

    logger.info('ESP32AudioProxy initialized (S3/WebRTC mode)');
  }

  /**
   * Create and configure WebSocket server for ESP32 devices
   */
  createWebSocketServer() {
    this.wss = new WebSocket.Server({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
    });

    // Periodic cleanup: ping/pong liveness check
    const cleanupInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          logger.warn('Terminating unresponsive ESP32 WebSocket (no pong received)');
          if (ws.esp32Id) this.unregisterESP32(ws.esp32Id);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 5000);

    this.wss.on('close', () => clearInterval(cleanupInterval));

    this.wss.on('connection', (ws, request) => {
      const clientIp = request.socket.remoteAddress || 'unknown';
      ws._clientIp = clientIp;

      // Per-IP connection cap
      const ipCount = (this._ipConnections.get(clientIp) || 0) + 1;
      if (ipCount > this._maxConnectionsPerIp) {
        logger.warn(`ESP32 connection rejected: IP ${clientIp} at cap (${ipCount})`);
        ws.close(1008, 'Connection limit reached');
        return;
      }
      this._ipConnections.set(clientIp, ipCount);

      logger.info(`ESP32 WebSocket connection from ${clientIp} (${ipCount}/${this._maxConnectionsPerIp})`);

      // TCP keepalive for faster disconnection detection
      const socket = request.socket;
      socket.setKeepAlive(true, 10000);
      socket.setTimeout(15000);

      ws.isAlive = true;
      ws.esp32Id = null;

      // Per-connection message rate state
      let msgCount = 0;
      let msgWindowStart = Date.now();

      ws.on('pong', () => { ws.isAlive = true; });

      socket.on('timeout', () => {
        logger.warn(`ESP32 socket timeout from ${clientIp}`);
        if (ws.esp32Id) this.unregisterESP32(ws.esp32Id);
        ws.terminate();
      });

      ws.on('close', () => {
        const remaining = (this._ipConnections.get(clientIp) || 1) - 1;
        if (remaining <= 0) {
          this._ipConnections.delete(clientIp);
        } else {
          this._ipConnections.set(clientIp, remaining);
        }
      });

      let esp32Info = null;

      ws.on('message', (data) => {
        // Control frames are JSON; the PCM audio stream is raw binary. Parse
        // as JSON first — success means a control message (register/signal/
        // ping), which is rate limited. A parse failure means an audio frame,
        // which we relay and deliberately exempt from the control-message
        // rate limiter: ~15 frames/s would trip it instantly. maxPayload on
        // the server still caps per-frame size.
        let message = null;
        try { message = JSON.parse(data.toString()); } catch { /* audio frame */ }

        if (message === null || typeof message !== 'object') {
          if (esp32Info) this.handleAudioData(esp32Info.id, data);
          return;
        }

        const now = Date.now();
        if (now - msgWindowStart > this._msgRateWindowMs) {
          msgCount = 0;
          msgWindowStart = now;
        }
        msgCount++;
        if (msgCount > this._msgRateMax) {
          logger.warn(`ESP32 message rate limit exceeded from ${clientIp}`);
          ws.close(1008, 'Rate limit exceeded');
          return;
        }

        try {
          const handled = this.handleJsonMessage(ws, message, () => esp32Info);
          if (handled.registered) esp32Info = handled.registered;
        } catch (error) {
          logger.error('Error processing ESP32 message:', error);
        }
      });

      ws.on('close', (code, reason) => {
        if (esp32Info) {
          logger.info(`ESP32 ${esp32Info.id} disconnected: ${code} ${reason}`);
          this.unregisterESP32(esp32Info.id);
        }
      });

      ws.on('error', (error) => {
        logger.error('ESP32 WebSocket error:', error);
      });
    });

    logger.info('ESP32 WebSocket server created');
    return this.wss;
  }

  /**
   * Route an incoming JSON message from an ESP32 WS to its handler.
   */
  handleJsonMessage(ws, message, getEsp32Info) {
    if (message.type === 'register') {
      return { registered: this.registerESP32(ws, message, ws._clientIp || '') };
    }
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      return {};
    }
    if (message.type === 'signal') {
      const info = getEsp32Info();
      if (!info) {
        logger.warn('signal from ESP before register, ignored');
        return {};
      }
      const { type, fromSocketId: _ignored, ...payload } = message;
      if (!payload.to) {
        logger.warn(`signal from ${info.id} missing 'to', dropping`);
        return {};
      }
      this.io.to(payload.to).emit('signal', {
        ...payload,
        from: 'baby',
        fromSocketId: info.id,
        fromUserName: info.name,
      });
      return {};
    }
    logger.warn(`Unknown message type: ${message.type}`);
    return {};
  }

  /**
   * Register a new ESP32 device
   */
  registerESP32(ws, registrationData, clientIp) {
    const { roomId, name, mac, sampleRate = 16000, channels = 1 } = registrationData;
    const deviceType = (typeof registrationData.device_type === 'string' && registrationData.device_type)
      ? registrationData.device_type
      : null;

    if (!roomId) {
      logger.error('ESP32 registration missing roomId');
      ws.send(JSON.stringify({ type: 'error', message: 'roomId required' }));
      ws.close();
      return null;
    }

    // MAC-derived ID so the device reuses the same slot across reboots
    const macClean = typeof mac === 'string' ? mac.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
    const esp32Id = macClean.length === 12
      ? `esp32_${macClean}`
      : `esp32_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const existing = this.esp32Clients.get(esp32Id);
    if (existing) {
      // Same physical device reconnecting — drop the stale socket silently
      if (existing.ws && existing.ws !== ws) {
        existing.ws.esp32Id = null;
        try { existing.ws.terminate(); } catch { /* ignore */ }
      }
      this.esp32Clients.delete(esp32Id);
    }

    const persistedName = this.deviceNames.get(esp32Id);

    const esp32Info = {
      id: esp32Id,
      ws,
      roomId,
      name: persistedName || name || 'ESP32 Baby',
      mac: macClean || null,
      clientIp,
      sampleRate,
      channels,
      deviceType,
      connectedAt: new Date(),
      connectedAtMs: Date.now(),
      audioPacketsReceived: 0,
      lastAudioPacket: null,
    };

    this.esp32Clients.set(esp32Id, esp32Info);
    ws.esp32Id = esp32Id;

    ws.send(JSON.stringify({
      type: 'registered',
      id: esp32Id,
      message: 'Successfully registered as baby device'
    }));

    if (!existing) {
      this.io.to(roomId).emit('participant-joined', {
        socketId: esp32Id,
        role: 'baby',
        userName: esp32Info.name,
        participants: this.getRoomParticipants(roomId),
        source: 'esp32',
        deviceType
      });
    }

    logger.info(`ESP32 ${existing ? 'reconnected' : 'registered'}: ${esp32Id} (${esp32Info.name}) in room ${roomId}`);
    return esp32Info;
  }

  /**
   * Relay a raw PCM audio frame from an ESP32 to every parent in its room.
   * S3 crying/level detection runs browser-side on the decoded stream, so the
   * server no longer inspects the audio — it only forwards it as `esp32-audio`.
   */
  handleAudioData(esp32Id, audioData) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) return;
    client.audioPacketsReceived = (client.audioPacketsReceived || 0) + 1;
    client.lastAudioPacket = new Date();
    this.io.to(client.roomId).emit('esp32-audio', {
      fromId: esp32Id,
      fromName: client.name,
      audio: audioData,
      timestamp: Date.now(),
      sampleRate: client.sampleRate,
      channels: client.channels,
      deviceType: client.deviceType,
    });
  }

  /**
   * Unregister an ESP32 device
   */
  unregisterESP32(esp32Id) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) return;

    const cfg = roomConfig.getConfig(client.roomId);
    if (cfg.ntfyEnabled && cfg.ntfyTopic && cfg.notifyOnDisconnect) {
      notificationService.sendDisconnectAlert(
        cfg.ntfyTopic,
        client.roomId,
        client.name,
        cfg.ntfyServer || null
      ).catch(err => {
        logger.error(`Failed to send disconnect notification for ${client.name}:`, err);
      });
    }

    this.io.to(client.roomId).emit('participant-left', {
      socketId: esp32Id,
      role: 'baby',
      participants: this.getRoomParticipants(client.roomId),
      source: 'esp32'
    });

    this.esp32Clients.delete(esp32Id);
    logger.info(`ESP32 unregistered: ${esp32Id} (${client.name})`);
  }

  /**
   * Get all participants in a room (Socket.IO + ESP32)
   */
  getRoomParticipants(roomId) {
    const participants = [];

    const room = this.io.sockets.adapter.rooms.get(roomId);
    if (room) {
      room.forEach(socketId => {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          participants.push({
            socketId: socket.id,
            role: socket.role || 'unknown',
            userName: socket.userName || 'Unknown',
            source: 'socketio'
          });
        }
      });
    }

    this.esp32Clients.forEach((client, esp32Id) => {
      if (client.roomId === roomId) {
        participants.push({
          socketId: esp32Id,
          role: 'baby',
          userName: client.name,
          source: 'esp32',
          deviceType: client.deviceType
        });
      }
    });

    return participants;
  }

  /**
   * Public statistics — aggregate only, no per-device PII.
   * Detailed per-device info is available via GET /api/rooms/:id/esp32/devices
   * (owner-authenticated).
   */
  getStatistics() {
    return {
      totalClients: this.esp32Clients.size,
    };
  }

  /**
   * Get ESP32 devices for a specific room (owner-authenticated path)
   */
  getDevicesForRoom(roomId) {
    const devices = [];
    this.esp32Clients.forEach((client, id) => {
      if (client.roomId === roomId) {
        devices.push({
          id,
          name: client.name,
          clientIp: client.clientIp,
          connectedAt: client.connectedAt,
          uptime: Date.now() - client.connectedAtMs,
          sampleRate: client.sampleRate,
          channels: client.channels,
          deviceType: client.deviceType
        });
      }
    });
    return devices;
  }

  /**
   * Rename an ESP32 device
   */
  renameDevice(esp32Id, newName) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) return null;
    client.name = newName;
    this.deviceNames.set(esp32Id, newName);
    return { id: esp32Id, name: client.name, roomId: client.roomId };
  }

  /**
   * Force disconnect an ESP32 device
   */
  forceDisconnect(esp32Id) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) return false;
    if (client.ws) client.ws.terminate();
    this.unregisterESP32(esp32Id);
    return true;
  }

  /**
   * Forward a WebRTC signaling message from a browser to an ESP32 peer.
   * The server is a pure relay — it does not inspect SDP/ICE content.
   */
  relaySignalToESP(esp32Id, signalData, fromSocketId, fromUserName) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client || !client.ws) return false;
    try {
      const frame = {
        type: 'signal',
        fromSocketId,
        fromUserName,
        ...signalData,
      };
      client.ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      logger.warn(`Failed to relay signal to ${esp32Id}: ${err.message}`);
      return false;
    }
  }

  /**
   * Send a factory-reset command to the device. The firmware clears its
   * stored config (WiFi credentials, server, room) and reboots into the
   * BLE + SoftAP provisioning portal.
   */
  sendFactoryReset(esp32Id) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client || !client.ws) return false;
    try {
      client.ws.send(JSON.stringify({ type: 'factory-reset' }));
    } catch (err) {
      logger.warn(`Failed to send factory-reset to ${esp32Id}: ${err.message}`);
      return false;
    }
    this.deviceNames.delete(esp32Id);
    this.unregisterESP32(esp32Id);
    return true;
  }

  /**
   * Handle HTTP upgrade for ESP32 WebSocket endpoint
   */
  handleUpgrade(request, socket, head) {
    if (!this.wss) {
      logger.error('WebSocket server not initialized');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }
}

module.exports = ESP32AudioProxy;
