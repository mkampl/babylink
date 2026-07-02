// Tests for POST /api/rooms and owner-token authentication contract.

const request = require('supertest');
const { startServer, createRoom } = require('../helpers/server-factory');
const crypto = require('crypto');

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('POST /api/rooms', () => {
  it('returns 201 with roomId and ownerToken', async () => {
    const res = await request(server.app).post('/api/rooms');
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('roomId');
    expect(res.body).toHaveProperty('ownerToken');
  });

  it('roomId is a 32-character hex string', async () => {
    const res = await request(server.app).post('/api/rooms');
    expect(res.body.roomId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('ownerToken is a 64-character hex string', async () => {
    const res = await request(server.app).post('/api/rooms');
    expect(res.body.ownerToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('each call returns a unique roomId', async () => {
    const r1 = await request(server.app).post('/api/rooms');
    const r2 = await request(server.app).post('/api/rooms');
    expect(r1.body.roomId).not.toBe(r2.body.roomId);
  });

  it('each call returns a unique ownerToken', async () => {
    const r1 = await request(server.app).post('/api/rooms');
    const r2 = await request(server.app).post('/api/rooms');
    expect(r1.body.ownerToken).not.toBe(r2.body.ownerToken);
  });
});

describe('Owner authentication on management endpoints', () => {
  it('returns 401 with no Authorization header', async () => {
    const { roomId } = await createRoom(server.app);
    const res = await request(server.app).get(`/api/rooms/${roomId}/esp32/devices`);
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const { roomId } = await createRoom(server.app);
    const fakeToken = crypto.randomBytes(32).toString('hex');
    const res = await request(server.app)
      .get(`/api/rooms/${roomId}/esp32/devices`)
      .set('Authorization', `Bearer ${fakeToken}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for lazy-created (unowned) room', async () => {
    const lazyRoomId = 'c0'.repeat(16);
    const fakeToken = crypto.randomBytes(32).toString('hex');
    const res = await request(server.app)
      .get(`/api/rooms/${lazyRoomId}/esp32/devices`)
      .set('Authorization', `Bearer ${fakeToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with valid owner token', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .get(`/api/rooms/${roomId}/esp32/devices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it('rejects token from a different room', async () => {
    const r1 = await createRoom(server.app);
    const r2 = await createRoom(server.app);
    // Use room 2's token to access room 1's devices
    const res = await request(server.app)
      .get(`/api/rooms/${r1.roomId}/esp32/devices`)
      .set('Authorization', `Bearer ${r2.ownerToken}`);
    expect(res.status).toBe(401);
  });
});

describe('maxRooms cap (POST /api/rooms)', () => {
  it('enforces the room cap and returns 429', async () => {
    const config = require('../../config');
    const roomConfig = require('../../server/room-config');

    // Save original size and temporarily fill configs
    const origMap = new Map(roomConfig.configs);
    const origMax = config.room.maxRooms;

    // Temporarily lower the cap and fill up to it
    config.room.maxRooms = roomConfig.configs.size + 1;
    // Fill exactly to cap
    for (let i = roomConfig.configs.size; i < config.room.maxRooms; i++) {
      roomConfig.configs.set(`filler${i}`, { ownerHash: 'dummy' });
    }

    try {
      const res = await request(server.app).post('/api/rooms');
      expect(res.status).toBe(429);
    } finally {
      // Restore
      config.room.maxRooms = origMax;
      roomConfig.configs.clear();
      for (const [k, v] of origMap) roomConfig.configs.set(k, v);
    }
  });
});
