// server/esp32-proxy.js
// WebSocket proxy for ESP32 baby devices
// Bridges ESP32 WebSocket connections to Socket.IO WebRTC signaling

const WebSocket = require('ws');
const logger = require('../utils/logger');
const roomConfig = require('./room-config');
const notificationService = require('./notification-service');

class ESP32AudioProxy {
  constructor(io) {
    this.io = io;
    this.esp32Clients = new Map(); // esp32Id -> client info
    // User-applied renames keyed by ESP32 ID. Lives beyond the client's
    // connection so a device reboot keeps its label.
    this.deviceNames = new Map(); // esp32Id -> name
    this.wss = null;

    // Crying detection configuration
    this.cryingThreshold = parseInt(process.env.CRYING_THRESHOLD) || 3000; // RMS amplitude threshold
    this.cryingDuration = parseInt(process.env.CRYING_DURATION) || 3000;   // ms of sustained crying needed
    this.cryingState = new Map(); // esp32Id -> { isCrying, cryingStart, lastCheck }

    logger.info('ESP32AudioProxy initialized');
    logger.info(`Crying detection: threshold=${this.cryingThreshold}, duration=${this.cryingDuration}ms`);
  }

  /**
   * Create and configure WebSocket server for ESP32 devices
   */
  createWebSocketServer() {
    this.wss = new WebSocket.Server({ noServer: true });

    // Periodic cleanup of dead connections with faster detection
    const cleanupInterval = setInterval(() => {
      const now = Date.now();

      // Check for stale ESP32 connections (no audio packets in last 10 seconds)
      this.esp32Clients.forEach((client, esp32Id) => {
        if (client.lastAudioPacket) {
          const timeSinceLastPacket = now - client.lastAudioPacket.getTime();
          if (timeSinceLastPacket > 10000) { // 10 seconds without audio = dead
            logger.warn(`ESP32 ${esp32Id} (${client.name}) - no audio for ${Math.round(timeSinceLastPacket/1000)}s, removing`);
            this.unregisterESP32(esp32Id);
            if (client.ws && client.ws.readyState === WebSocket.OPEN) {
              client.ws.terminate();
            }
          }
        }
      });

      // Also check WebSocket ping/pong
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          logger.warn('Terminating unresponsive ESP32 WebSocket (no pong received)');

          // Find and unregister this ESP32
          if (ws.esp32Id) {
            this.unregisterESP32(ws.esp32Id);
          }

          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 5000); // Check every 5 seconds for faster disconnection detection

    this.wss.on('close', () => {
      clearInterval(cleanupInterval);
    });

    this.wss.on('connection', (ws, request) => {
      const clientIp = request.socket.remoteAddress;
      logger.info(`ESP32 WebSocket connection from ${clientIp}`);

      // Enable TCP keepalive for faster disconnection detection
      const socket = request.socket;
      socket.setKeepAlive(true, 10000); // Send keepalive probes every 10 seconds
      socket.setTimeout(15000); // Timeout after 15 seconds of inactivity

      ws.isAlive = true;
      ws.esp32Id = null; // Will be set during registration

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      // Handle socket timeout
      socket.on('timeout', () => {
        logger.warn(`ESP32 socket timeout from ${clientIp}`);
        if (ws.esp32Id) {
          this.unregisterESP32(ws.esp32Id);
        }
        ws.terminate();
      });

      let esp32Info = null;

      ws.on('message', (data) => {
        try {
          if (data instanceof Buffer) {
            // Try to parse as JSON first
            try {
              const message = JSON.parse(data.toString());
              logger.debug('ESP32 JSON message received:', message);

              if (message.type === 'register') {
                esp32Info = this.registerESP32(ws, message, clientIp);
              } else if (message.type === 'ping') {
                // Heartbeat response
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
              } else {
                logger.warn(`Unknown message type: ${message.type}`);
              }
              return;
            } catch (parseError) {
              // Not JSON, treat as audio data
              if (esp32Info) {
                this.handleAudioData(esp32Info.id, data);
              } else {
                logger.warn('Received audio data before registration');
              }
            }
          } else {
            // String message
            const message = JSON.parse(data.toString());
            logger.debug('ESP32 text message received:', message);

            if (message.type === 'register') {
              esp32Info = this.registerESP32(ws, message, clientIp);
            } else if (message.type === 'ping') {
              // Heartbeat response
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            } else {
              logger.warn(`Unknown message type: ${message.type}`);
            }
          }
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
   * Register a new ESP32 device
   */
  registerESP32(ws, registrationData, clientIp) {
    const { roomId, name, mac, sampleRate = 16000, channels = 1 } = registrationData;
    // Hardware generation tag. Classic ESP32 + INMP441 firmware omits this
    // field — default to 'esp32-classic' so old clients still get a sensible
    // label without a firmware update. New XIAO-S3 firmware sends 'esp32-s3'.
    const deviceType = (typeof registrationData.device_type === 'string' && registrationData.device_type)
      ? registrationData.device_type
      : 'esp32-classic';

    if (!roomId) {
      logger.error('ESP32 registration missing roomId');
      ws.send(JSON.stringify({ type: 'error', message: 'roomId required' }));
      ws.close();
      return null;
    }

    // Stable ID derived from MAC when the firmware provides one. Stable IDs
    // mean a device reboot reuses the same slot — UI buttons stamped with
    // the ID stay valid across reconnects, and user renames persist until
    // the device is factory-reset or the server restarts.
    // Legacy firmware (no MAC) falls back to a timestamped random ID.
    const macClean = typeof mac === 'string' ? mac.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
    const esp32Id = macClean.length === 12
      ? `esp32_${macClean}`
      : `esp32_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const existing = this.esp32Clients.get(esp32Id);
    if (existing) {
      // Same physical device reconnecting. Drop the stale socket without
      // firing the usual participant-left/-joined churn.
      if (existing.ws && existing.ws !== ws) {
        existing.ws.esp32Id = null; // prevent close handler from unregistering
        try { existing.ws.terminate(); } catch (_) { /* ignore */ }
      }
      this.cryingState.delete(esp32Id);
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
      audioPacketsReceived: 0,
      lastAudioPacket: null
    };

    this.esp32Clients.set(esp32Id, esp32Info);

    // Store ESP32 ID on WebSocket for cleanup
    ws.esp32Id = esp32Id;

    // Send registration confirmation
    ws.send(JSON.stringify({
      type: 'registered',
      id: esp32Id,
      message: 'Successfully registered as baby device'
    }));

    // Only announce a new participant on first registration; reconnects of
    // the same MAC are transparent to listeners.
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

    logger.info(`✅ ESP32 ${existing ? 'reconnected' : 'registered'}: ${esp32Id} (${esp32Info.name}) in room ${roomId}`);

    return esp32Info;
  }

  /**
   * Handle incoming audio data from ESP32
   */
  /**
   * Calculate RMS (Root Mean Square) amplitude from audio buffer
   * @param {Buffer} audioData - 16-bit PCM audio data
   * @returns {number} RMS amplitude
   */
  calculateRMS(audioData) {
    if (audioData.length < 2) return 0;

    let sum = 0;
    const sampleCount = audioData.length / 2; // 2 bytes per 16-bit sample

    for (let i = 0; i < audioData.length; i += 2) {
      const sample = audioData.readInt16LE(i);
      sum += sample * sample;
    }

    return Math.sqrt(sum / sampleCount);
  }

  /**
   * Detect crying in audio data and trigger notifications
   * @param {string} esp32Id - ESP32 device ID
   * @param {Buffer} audioData - Audio data buffer
   * @param {object} client - Client info
   */
  async detectCrying(esp32Id, audioData, client) {
    // Calculate RMS amplitude
    const rms = this.calculateRMS(audioData);

    // Get or initialize crying state
    let state = this.cryingState.get(esp32Id);
    if (!state) {
      state = { isCrying: false, cryingStart: null, lastCheck: Date.now() };
      this.cryingState.set(esp32Id, state);
    }

    const now = Date.now();
    const isCryingNow = rms > this.cryingThreshold;

    if (isCryingNow) {
      if (!state.cryingStart) {
        // Crying just started
        state.cryingStart = now;
        logger.debug(`ESP32 ${esp32Id}: Crying detected (RMS: ${Math.round(rms)})`);
      } else {
        // Crying continues
        const cryingDuration = now - state.cryingStart;

        // If crying for long enough and not already notified
        if (cryingDuration >= this.cryingDuration && !state.isCrying) {
          state.isCrying = true;

          // Check if room has notifications enabled
          const config = roomConfig.getConfig(client.roomId);
          if (config.ntfyEnabled && config.ntfyTopic && config.notifyOnCrying) {
            logger.info(`Sending crying alert for ${client.name} in room ${client.roomId}`);

            // Get server URL for click action
            const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`;

            await notificationService.sendCryingAlert(
              config.ntfyTopic,
              client.roomId,
              client.name,
              serverUrl
            );
          }
        }
      }
    } else {
      // Not crying or below threshold
      if (state.cryingStart) {
        const cryingDuration = now - state.cryingStart;
        if (cryingDuration < this.cryingDuration) {
          logger.debug(`ESP32 ${esp32Id}: Crying stopped (duration: ${cryingDuration}ms, too short to notify)`);
        }
      }

      // Reset crying state
      state.isCrying = false;
      state.cryingStart = null;
    }

    state.lastCheck = now;
  }

  handleAudioData(esp32Id, audioData) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) {
      logger.warn(`Audio data from unknown ESP32: ${esp32Id}`);
      return;
    }

    client.audioPacketsReceived++;
    client.lastAudioPacket = new Date();

    // Detect crying in audio data
    this.detectCrying(esp32Id, audioData, client).catch(err => {
      logger.error(`Error detecting crying for ESP32 ${esp32Id}:`, err);
    });

    // Forward audio data to all parents in the room via Socket.IO
    // Parents will need to handle this with a custom audio handler
    this.io.to(client.roomId).emit('esp32-audio', {
      fromId: esp32Id,
      fromName: client.name,
      audio: audioData,
      timestamp: Date.now(),
      sampleRate: client.sampleRate,
      channels: client.channels
    });

    // Log every 100 packets to avoid spam
    if (client.audioPacketsReceived % 100 === 0) {
      logger.debug(`ESP32 ${esp32Id}: ${client.audioPacketsReceived} audio packets received`);
    }
  }

  /**
   * Unregister an ESP32 device
   */
  unregisterESP32(esp32Id) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) return;

    // Send disconnect notification if configured
    const config = roomConfig.getConfig(client.roomId);
    if (config.ntfyEnabled && config.ntfyTopic && config.notifyOnDisconnect) {
      notificationService.sendDisconnectAlert(
        config.ntfyTopic,
        client.roomId,
        client.name
      ).catch(err => {
        logger.error(`Failed to send disconnect notification for ${client.name}:`, err);
      });
    }

    // Notify Socket.IO room that baby left
    this.io.to(client.roomId).emit('participant-left', {
      socketId: esp32Id,
      role: 'baby',
      participants: this.getRoomParticipants(client.roomId),
      source: 'esp32'
    });

    // Clean up crying state
    this.cryingState.delete(esp32Id);

    this.esp32Clients.delete(esp32Id);

    logger.info(`❌ ESP32 unregistered: ${esp32Id} (${client.name})`);
  }

  /**
   * Get all participants in a room (including Socket.IO and ESP32)
   */
  getRoomParticipants(roomId) {
    const participants = [];

    // Add Socket.IO participants
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

    // Add ESP32 participants
    this.esp32Clients.forEach((client, esp32Id) => {
      if (client.roomId === roomId) {
        participants.push({
          socketId: esp32Id,
          role: 'baby',
          userName: client.name,
          source: 'esp32',
          deviceType: client.deviceType || 'esp32-classic'
        });
      }
    });

    return participants;
  }

  /**
   * Get statistics about ESP32 connections
   */
  getStatistics() {
    const stats = {
      totalClients: this.esp32Clients.size,
      clients: []
    };

    this.esp32Clients.forEach((client, id) => {
      stats.clients.push({
        id,
        name: client.name,
        roomId: client.roomId,
        clientIp: client.clientIp,
        connectedAt: client.connectedAt,
        audioPacketsReceived: client.audioPacketsReceived,
        lastAudioPacket: client.lastAudioPacket,
        uptime: Date.now() - client.connectedAt.getTime()
      });
    });

    return stats;
  }

  /**
   * Get ESP32 devices for a specific room
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
          audioPacketsReceived: client.audioPacketsReceived,
          lastAudioPacket: client.lastAudioPacket,
          uptime: Date.now() - client.connectedAt.getTime(),
          sampleRate: client.sampleRate,
          channels: client.channels,
          deviceType: client.deviceType || 'esp32-classic'
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
    return {
      id: esp32Id,
      name: client.name,
      roomId: client.roomId
    };
  }

  /**
   * Force disconnect an ESP32 device
   */
  forceDisconnect(esp32Id) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) return false;
    if (client.ws) {
      client.ws.terminate();
    }
    this.unregisterESP32(esp32Id);
    return true;
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
    // Factory reset wipes the device back to defaults — drop any persisted
    // rename so the device shows up under its firmware-supplied name when
    // it (or a different device) reuses the same MAC.
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
