// Server hardening: rate limits, room-config lifecycle, PIN lockout pruning,
// Socket.IO liveness timing, LAN hint exposure, device list fields.

const request = require('supertest');
const config = require('../../config');
const roomConfig = require('../../server/room-config');
const { startServer, createRoom } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');

describe('general rate limiter (B4)', () => {
  // vitest.config.js raises RATE_LIMIT_MAX_REQUESTS for the whole suite, so
  // these tests set the limit explicitly.
  let s;
  let orig;
  beforeAll(async () => {
    orig = config.security.rateLimitMaxRequests;
    config.security.rateLimitMaxRequests = 50;
    s = await startServer();
  });
  afterAll(async () => {
    config.security.rateLimitMaxRequests = orig;
    await s.close();
  });

  it('does not count locale files', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await request(s.app).get('/locales/en.json');
      expect(res.status).toBe(200);
    }
    expect((await request(s.app).get('/api/esp32/status')).status).toBe(200);
  });

  it('API calls beyond the limit are rejected with 429', async () => {
    let last;
    for (let i = 0; i < 55; i++) last = await request(s.app).get('/api/esp32/status');
    expect(last.status).toBe(429);
  });

  it('the production default leaves room for a household polling the device list', () => {
    const saved = process.env.RATE_LIMIT_MAX_REQUESTS;
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
    const path = require.resolve('../../config');
    delete require.cache[path];
    try {
      const fresh = require('../../config');
      // two parents with the settings panel open (poll every 30 s for 15 min)
      // plus page loads and API calls from several phones behind one NAT
      expect(fresh.security.rateLimitMaxRequests).toBeGreaterThanOrEqual(300);
    } finally {
      if (saved !== undefined) process.env.RATE_LIMIT_MAX_REQUESTS = saved;
      delete require.cache[path];
      require('../../config');
    }
  });
});

describe('room creation limiter (S5)', () => {
  it('rate-limits POST /api/rooms separately', async () => {
    const orig = config.security.roomCreateMax;
    config.security.roomCreateMax = 3;
    const s = await startServer();
    try {
      for (let i = 0; i < 3; i++) {
        expect((await request(s.app).post('/api/rooms')).status).toBe(201);
      }
      expect((await request(s.app).post('/api/rooms')).status).toBe(429);
    } finally {
      config.security.roomCreateMax = orig;
      await s.close();
    }
  });
});
