// server/esp32-proxy.js
// WebSocket proxy for ESP32 baby devices
// Bridges ESP32 WebSocket connections to Socket.IO WebRTC signaling

const WebSocket = require('ws');
const logger = require('../utils/logger');

class ESP32AudioProxy {
  constructor(io) {
    this.io = io;
    this.esp32Clients = new Map(); // esp32Id -> client info
    this.wss = null;

    logger.info('ESP32AudioProxy initialized');
  }

  /**
   * Create and configure WebSocket server for ESP32 devices
   */
  createWebSocketServer() {
    this.wss = new WebSocket.Server({ noServer: true });

    // Periodic cleanup of dead connections with faster detection
    const cleanupInterval = setInterval(() => {
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
    const { roomId, name, sampleRate = 16000, channels = 1 } = registrationData;

    if (!roomId) {
      logger.error('ESP32 registration missing roomId');
      ws.send(JSON.stringify({ type: 'error', message: 'roomId required' }));
      ws.close();
      return null;
    }

    // Generate unique ID for this ESP32
    const esp32Id = `esp32_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const esp32Info = {
      id: esp32Id,
      ws,
      roomId,
      name: name || 'ESP32 Baby',
      clientIp,
      sampleRate,
      channels,
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

    // Notify Socket.IO room that new baby joined
    this.io.to(roomId).emit('participant-joined', {
      socketId: esp32Id,
      role: 'baby',
      userName: esp32Info.name,
      participants: this.getRoomParticipants(roomId),
      source: 'esp32'
    });

    logger.info(`✅ ESP32 registered: ${esp32Id} (${esp32Info.name}) in room ${roomId}`);

    return esp32Info;
  }

  /**
   * Handle incoming audio data from ESP32
   */
  handleAudioData(esp32Id, audioData) {
    const client = this.esp32Clients.get(esp32Id);
    if (!client) {
      logger.warn(`Audio data from unknown ESP32: ${esp32Id}`);
      return;
    }

    client.audioPacketsReceived++;
    client.lastAudioPacket = new Date();

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

    // Notify Socket.IO room that baby left
    this.io.to(client.roomId).emit('participant-left', {
      socketId: esp32Id,
      role: 'baby',
      participants: this.getRoomParticipants(client.roomId),
      source: 'esp32'
    });

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
          source: 'esp32'
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
