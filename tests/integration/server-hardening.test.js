// Server hardening: rate limits, room-config lifecycle, PIN lockout pruning,
// Socket.IO liveness timing, LAN hint exposure, device list fields.

const request = require('supertest');
const config = require('../../config');
const roomConfig = require('../../server/room-config');
const { startServer, createRoom } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');

describe('Socket.IO liveness (R5)', () => {
  it('detects a dead client within ~15 s, not the 45 s default', async () => {
    const s = await startServer();
    try {
      expect(s.io.engine.opts.pingInterval).toBe(10000);
      expect(s.io.engine.opts.pingTimeout).toBe(5000);
    } finally {
      await s.close();
    }
  });
});
