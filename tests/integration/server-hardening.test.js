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

describe('room config expiry (S5)', () => {
  const DAY = 24 * 3600 * 1000;
  let saved;
  beforeEach(() => { saved = new Map(roomConfig.configs); roomConfig.configs.clear(); });
  afterEach(() => {
    roomConfig.configs.clear();
    for (const [k, v] of saved) roomConfig.configs.set(k, v);
  });

  it('drops long-unused rooms that have no PIN and no notifications', async () => {
    const now = Date.now();
    const old = now - (config.room.configTtlDays + 1) * DAY;
    roomConfig.configs.set('a'.repeat(32), { ownerHash: 'x', lastUsedAt: old });
    roomConfig.configs.set('b'.repeat(32), { ownerHash: 'x', lastUsedAt: now - DAY });
    roomConfig.configs.set('c'.repeat(32), { ownerHash: 'x', lastUsedAt: old, pin: { salt: 's', hash: 'h' } });
    roomConfig.configs.set('d'.repeat(32), { ownerHash: 'x', lastUsedAt: old, ntfyEnabled: true, ntfyTopic: 't' });
    roomConfig.configs.set('e'.repeat(32), { ownerHash: 'x', lastUsedAt: old });

    const removed = await roomConfig.expireStale(now, config.room.configTtlDays * DAY,
      (id) => id === 'e'.repeat(32) /* still in use right now */);

    expect(removed).toEqual(['a'.repeat(32)]);
    expect([...roomConfig.configs.keys()].sort()).toEqual(
      ['b', 'c', 'd', 'e'].map(ch => ch.repeat(32)));
  });

  it('configs without lastUsedAt (written by older versions) are not expired on first sight', async () => {
    const now = Date.now();
    roomConfig.configs.set('f'.repeat(32), { ownerHash: 'x' });
    const removed = await roomConfig.expireStale(now, DAY, () => false);
    expect(removed).toEqual([]);
    expect(roomConfig.configs.get('f'.repeat(32)).lastUsedAt).toBe(now);
  });

  it('the sweep persists lastUsedAt refreshed by touch(), so a restart does not forget recent use', async () => {
    const now = Date.now();
    const id = 'g'.repeat(32);
    roomConfig.configs.set(id, { ownerHash: 'x', lastUsedAt: now - 30 * DAY });
    const save = vi.spyOn(roomConfig, 'save').mockResolvedValue();
    try {
      roomConfig.touch(id, now);
      await roomConfig.expireStale(now, config.room.configTtlDays * DAY, () => false);
      expect(save).toHaveBeenCalledTimes(1);

      // Nothing touched since: the next sweep has nothing to write.
      save.mockClear();
      await roomConfig.expireStale(now + 1, config.room.configTtlDays * DAY, () => false);
      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  it('owner API use and joins refresh lastUsedAt', async () => {
    const s = await startServer();
    try {
      const { roomId, ownerToken } = await createRoom(s.app);
      roomConfig.configs.get(roomId).lastUsedAt = 1;
      await request(s.app)
        .get(`/api/rooms/${roomId}/esp32/devices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(roomConfig.configs.get(roomId).lastUsedAt).toBeGreaterThan(1);
    } finally {
      await s.close();
    }
  });
});

describe('PIN lockout map is pruned (B7)', () => {
  it('expired lockout entries are removed by the cleanup sweep', () => {
    const { _pinLockout, prunePinLockout } = require('../../server');
    _pinLockout.clear();
    const now = Date.now();
    _pinLockout.set('r:1.1.1.1', { failures: 2, lockedUntil: 0, lastFailureAt: now - 2 * 3600_000 });
    _pinLockout.set('r:2.2.2.2', { failures: 7, lockedUntil: now + 60_000, lastFailureAt: now });
    _pinLockout.set('r:3.3.3.3', { failures: 1, lockedUntil: 0, lastFailureAt: now - 1000 });
    prunePinLockout(now);
    expect([..._pinLockout.keys()].sort()).toEqual(['r:2.2.2.2', 'r:3.3.3.3']);
  });
});

describe('server-hint does not leak the LAN address publicly (S6)', () => {
  let s;
  beforeAll(async () => { s = await startServer(); });
  afterAll(async () => { await s.close(); });

  it('a public requester gets the public host it already used', async () => {
    const res = await request(s.app)
      .get('/api/config/server-hint')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('Host', 'babylink.example.org');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('babylink.example.org');
  });

  it('a public requester gets a configured PUBLIC_HOST that is itself public', async () => {
    process.env.PUBLIC_HOST = 'babylink.example.org';
    try {
      const res = await request(s.app).get('/api/config/server-hint').set('X-Forwarded-For', '203.0.113.7');
      expect(res.body.host).toBe('babylink.example.org');
      process.env.PUBLIC_HOST = '192.168.1.5';
      const lan = await request(s.app).get('/api/config/server-hint')
        .set('X-Forwarded-For', '203.0.113.7').set('Host', 'monitor.example.org');
      expect(lan.body.host).toBe('monitor.example.org');
    } finally {
      delete process.env.PUBLIC_HOST;
    }
  });

  it('a LAN requester still gets a LAN hint', async () => {
    const res = await request(s.app)
      .get('/api/config/server-hint')
      .set('X-Forwarded-For', '192.168.1.20');
    expect(res.status).toBe(200);
    expect(typeof res.body.host).toBe('string');
    expect(res.body.port).toBeGreaterThan(0);
  });
});

describe('device list fields (B6)', () => {
  it('includes mac and audio packet counters', async () => {
    const s = await startServer();
    const esp = createESP32Client(s.port);
    try {
      const { roomId, ownerToken } = await createRoom(s.app);
      await esp.register(roomId, 'Nursery', 'AA:BB:CC:DD:EE:B6');
      esp.sendAudio();
      esp.sendAudio();
      await new Promise(r => setTimeout(r, 150));
      const res = await request(s.app)
        .get(`/api/rooms/${roomId}/esp32/devices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const d = res.body.devices[0];
      expect(d.mac).toBe('aabbccddeeb6');
      expect(d.audioPacketsReceived).toBe(2);
      expect(typeof d.lastAudioAt).toBe('string');
    } finally {
      await esp.close();
      await s.close();
    }
  });
});
