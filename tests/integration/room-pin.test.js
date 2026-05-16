const request = require('supertest');
const { startServer } = require('../helpers/server-factory');
const { createSocketClient } = require('../helpers/socket-client');

// Use unique room IDs for PIN tests to avoid state collisions with other test files
const PIN_ROOM = 'd'.repeat(32);
const PIN_ROOM_2 = 'e'.repeat(32);
const PIN_ROOM_3 = 'f1'.repeat(16);
const PIN_ROOM_SOCKET = 'f2'.repeat(16);

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
      const res = await request(server.app)
        .get(`/api/rooms/${PIN_ROOM}/pin`);
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(false);
    });

    it('rejects invalid room ID', async () => {
      const res = await request(server.app)
        .get('/api/rooms/invalid/pin');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/rooms/:roomId/pin', () => {
    it('sets a 4-digit PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin`)
        .send({ pin: '1234' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.hasPin).toBe(true);
    });

    it('sets a 6-digit PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM_2}/pin`)
        .send({ pin: '123456' });
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(true);
    });

    it('rejects PIN shorter than 4 digits', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM_3}/pin`)
        .send({ pin: '123' });
      expect(res.status).toBe(400);
    });

    it('rejects PIN longer than 6 digits', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM_3}/pin`)
        .send({ pin: '1234567' });
      expect(res.status).toBe(400);
    });

    it('rejects non-numeric PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM_3}/pin`)
        .send({ pin: 'abcd' });
      expect(res.status).toBe(400);
    });

    it('returns hasPin: true after PIN is set', async () => {
      const res = await request(server.app)
        .get(`/api/rooms/${PIN_ROOM}/pin`);
      expect(res.body.hasPin).toBe(true);
    });

    it('requires current PIN to change existing PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin`)
        .send({ pin: '5678' });
      expect(res.status).toBe(403);
    });

    it('allows changing PIN with correct current PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin`)
        .send({ pin: '5678', currentPin: '1234' });
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(true);
    });

    it('removes PIN when pin is null with correct current PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin`)
        .send({ pin: null, currentPin: '5678' });
      expect(res.status).toBe(200);
      expect(res.body.hasPin).toBe(false);
    });
  });

  describe('POST /api/rooms/:roomId/pin/verify', () => {
    it('returns valid: true when no PIN is set', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin/verify`)
        .send({ pin: '1234' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.hasPin).toBe(false);
    });

    it('verifies correct PIN', async () => {
      // Set a PIN first
      await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin`)
        .send({ pin: '9999' });

      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin/verify`)
        .send({ pin: '9999' });
      expect(res.body.valid).toBe(true);
    });

    it('rejects incorrect PIN', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin/verify`)
        .send({ pin: '0000' });
      expect(res.body.valid).toBe(false);
    });

    it('rejects empty PIN when PIN is set', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${PIN_ROOM}/pin/verify`)
        .send({ pin: '' });
      expect(res.body.valid).toBe(false);
    });
  });
});

describe('Socket.IO PIN enforcement', () => {
  it('allows joining room without PIN when no PIN set', async () => {
    const client = createSocketClient(server.port);
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('room-state', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });
        client.on('error', (data) => {
          clearTimeout(timeout);
          reject(new Error(data.message));
        });
        client.emit('join', { roomId: PIN_ROOM_SOCKET, role: 'baby', userName: 'TestBaby' });
      });
      expect(result.participants).toBeDefined();
    } finally {
      client.disconnect();
    }
  });

  it('rejects joining PIN-protected room without PIN', async () => {
    // Set a PIN
    await request(server.app)
      .post(`/api/rooms/${PIN_ROOM_SOCKET}/pin`)
      .send({ pin: '4321' });

    const client = createSocketClient(server.port);
    try {
      const error = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('error', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });
        client.on('room-state', () => {
          clearTimeout(timeout);
          reject(new Error('Should not have joined'));
        });
        client.emit('join', { roomId: PIN_ROOM_SOCKET, role: 'baby', userName: 'TestBaby' });
      });
      expect(error.code).toBe('INVALID_PIN');
    } finally {
      client.disconnect();
    }
  });

  it('allows joining PIN-protected room with correct PIN', async () => {
    const client = createSocketClient(server.port);
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('room-state', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });
        client.on('error', (data) => {
          clearTimeout(timeout);
          reject(new Error(data.message));
        });
        client.emit('join', { roomId: PIN_ROOM_SOCKET, role: 'baby', userName: 'TestBaby', pin: '4321' });
      });
      expect(result.participants).toBeDefined();
    } finally {
      client.disconnect();
    }
  });

  it('rejects joining PIN-protected room with wrong PIN', async () => {
    const client = createSocketClient(server.port);
    try {
      const error = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('error', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });
        client.on('room-state', () => {
          clearTimeout(timeout);
          reject(new Error('Should not have joined'));
        });
        client.emit('join', { roomId: PIN_ROOM_SOCKET, role: 'baby', userName: 'TestBaby', pin: '0000' });
      });
      expect(error.code).toBe('INVALID_PIN');
    } finally {
      client.disconnect();
    }
  });
});
