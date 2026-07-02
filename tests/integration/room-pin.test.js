const request = require('supertest');
const { startServer, createRoom } = require('../helpers/server-factory');
const { createSocketClient } = require('../helpers/socket-client');

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('Room PIN API', () => {
  describe('GET /api/rooms/:roomId/pin', () => {
    it('returns hasPin: false for room without PIN', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app).get(`/api/rooms/${roomId}/pin`);
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(false);
    });

    it('rejects invalid room ID', async () => {
      const res = await request(server.app).get('/api/rooms/invalid/pin');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/rooms/:roomId/pin (owner-authenticated)', () => {
    it('requires owner token — returns 401 without header', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .send({ pin: '123456' });
      expect(res.status).toBe(401);
    });

    it('returns 403 for lazy-created room (no owner)', async () => {
      const lazyRoomId = 'f0'.repeat(16); // not created via POST /api/rooms
      const res = await request(server.app)
        .post(`/api/rooms/${lazyRoomId}/pin`)
        .set('Authorization', 'Bearer some-token')
        .send({ pin: '123456' });
      expect(res.status).toBe(403);
    });

    it('sets a 6-digit PIN', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '123456' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.hasPin).toBe(true);
    });

    it('sets an 8-digit PIN', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '12345678' });
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(true);
    });

    it('rejects 4-digit PIN (below minimum)', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '1234' });
      expect(res.status).toBe(400);
    });

    it('rejects 5-digit PIN (below minimum)', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '12345' });
      expect(res.status).toBe(400);
    });

    it('rejects PIN longer than 8 digits', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '123456789' });
      expect(res.status).toBe(400);
    });

    it('rejects non-numeric PIN', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: 'abcdef' });
      expect(res.status).toBe(400);
    });

    it('returns hasPin: true after PIN is set', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '654321' });

      const res = await request(server.app).get(`/api/rooms/${roomId}/pin`);
      expect(res.body.hasPin).toBe(true);
    });

    it('can change PIN with owner token (no currentPin needed)', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      // Set initial PIN
      await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '111111' });
      // Change it — owner token is sufficient
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '222222' });
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(true);
    });

    it('removes PIN when pin is null', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '999999' });

      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: null });
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(false);
    });
  });

  describe('POST /api/rooms/:roomId/pin/verify (public)', () => {
    it('returns valid: true when no PIN is set', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin/verify`)
        .send({ pin: '123456' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.hasPin).toBe(false);
    });

    it('verifies correct PIN', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '999999' });

      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin/verify`)
        .send({ pin: '999999' });
      expect(res.body.valid).toBe(true);
    });

    it('rejects incorrect PIN', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '999999' });

      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin/verify`)
        .send({ pin: '000000' });
      expect(res.body.valid).toBe(false);
    });

    it('rejects empty PIN when PIN is set', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      await request(server.app)
        .post(`/api/rooms/${roomId}/pin`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ pin: '888888' });

      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/pin/verify`)
        .send({ pin: '' });
      expect(res.body.valid).toBe(false);
    });
  });
});

describe('Socket.IO PIN enforcement', () => {
  it('allows joining room without PIN when no PIN set', async () => {
    const { roomId } = await createRoom(server.app);
    const client = createSocketClient(server.port);
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('room-state', (data) => { clearTimeout(timeout); resolve(data); });
        client.on('error', (data) => { clearTimeout(timeout); reject(new Error(data.message)); });
        client.emit('join', { roomId, role: 'baby', userName: 'TestBaby' });
      });
      expect(result.participants).toBeDefined();
    } finally {
      client.disconnect();
    }
  });

  it('rejects joining PIN-protected room without PIN', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    // Set a PIN
    await request(server.app)
      .post(`/api/rooms/${roomId}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: '432100' });

    const client = createSocketClient(server.port);
    try {
      const error = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('error', (data) => { clearTimeout(timeout); resolve(data); });
        client.on('room-state', () => { clearTimeout(timeout); reject(new Error('Should not have joined')); });
        client.emit('join', { roomId, role: 'baby', userName: 'TestBaby' });
      });
      expect(error.code).toBe('INVALID_PIN');
    } finally {
      client.disconnect();
    }
  });

  it('allows joining PIN-protected room with correct PIN', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    await request(server.app)
      .post(`/api/rooms/${roomId}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: '432100' });

    const client = createSocketClient(server.port);
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('room-state', (data) => { clearTimeout(timeout); resolve(data); });
        client.on('error', (data) => { clearTimeout(timeout); reject(new Error(data.message)); });
        client.emit('join', { roomId, role: 'baby', userName: 'TestBaby', pin: '432100' });
      });
      expect(result.participants).toBeDefined();
    } finally {
      client.disconnect();
    }
  });

  it('rejects joining PIN-protected room with wrong PIN', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    await request(server.app)
      .post(`/api/rooms/${roomId}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: '432100' });

    const client = createSocketClient(server.port);
    try {
      const error = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('error', (data) => { clearTimeout(timeout); resolve(data); });
        client.on('room-state', () => { clearTimeout(timeout); reject(new Error('Should not have joined')); });
        client.emit('join', { roomId, role: 'baby', userName: 'TestBaby', pin: '000000' });
      });
      expect(error.code).toBe('INVALID_PIN');
    } finally {
      client.disconnect();
    }
  });
});
