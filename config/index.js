// config/index.js - Centralized configuration management
require('dotenv').config();

const config = {
  // Server Configuration
  server: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3001,
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
  },

  // WebRTC Configuration
  webrtc: {
    iceServers: [
      {
        urls: process.env.STUN_SERVER || 'stun:stun.l.google.com:19302'
      }
    ]
  },

  // Add TURN server if configured
  get webrtcWithTurn() {
    const servers = [...this.webrtc.iceServers];
    if (process.env.TURN_SERVER) {
      servers.push({
        urls: process.env.TURN_SERVER,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_PASSWORD
      });
    }
    return { iceServers: servers };
  },

  // Room Configuration
  room: {
    maxRooms: parseInt(process.env.MAX_ROOMS, 10) || 1000,
    maxBabiesPerRoom: parseInt(process.env.MAX_BABIES_PER_ROOM, 10) || 5,
    maxParentsPerRoom: parseInt(process.env.MAX_PARENTS_PER_ROOM, 10) || 10,
    // Per-IP cap on simultaneous socket connections (anti-DoS)
    maxSocketsPerIp: parseInt(process.env.MAX_SOCKETS_PER_IP, 10) || 20,
    cleanupInterval: parseInt(process.env.ROOM_CLEANUP_INTERVAL, 10) || 3600000, // 1 hour
    roomIdLength: 32, // 32 hex characters
    roomIdPattern: /^[a-f0-9]{32}$/i, // Hex string validator
  },

  // Security Configuration
  security: {
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW, 10) || 900000, // 15 minutes
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
    // CORS: default to same-origin; set CORS_ORIGIN=* only in dev if cross-origin is needed
    corsOrigin: process.env.CORS_ORIGIN || false,
    corsCredentials: process.env.CORS_CREDENTIALS === 'true',
    // ntfy allowlist: default ntfy.sh; extras via comma-separated NTFY_ALLOWED_HOSTS
    ntfyAllowedHosts: ['ntfy.sh'],
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    toFile: process.env.LOG_TO_FILE === 'true',
    filePath: process.env.LOG_FILE_PATH || './logs/babylink.log',
  },

  // Feature Flags
  features: {
    multiBaby: process.env.ENABLE_MULTI_BABY !== 'false', // Enabled by default
  },

  // Validation helpers
  validation: {
    isValidRoomId(roomId) {
      return typeof roomId === 'string' && config.room.roomIdPattern.test(roomId);
    },
    isValidRole(role) {
      return role === 'baby' || role === 'parent';
    },
    isValidUserName(name) {
      return typeof name === 'string' && name.length >= 1 && name.length <= 50;
    }
  }
};

module.exports = config;
