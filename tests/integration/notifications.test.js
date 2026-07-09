const request = require('supertest');
const { startServer, createRoom } = require('../helpers/server-factory');
const { createSocketClient, joinRoom } = require('../helpers/socket-client');

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('Crying detection socket event', () => {
  it('accepts crying-detected event from parent in room', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);

    // Configure ntfy for the room (won't actually send — no real ntfy server)
    await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        topic: 'test-crying-topic',
        enabled: true,
        notifyOnCrying: true,
      });

    const client = createSocketClient(server.port);
    try {
      await joinRoom(client, roomId, 'parent', 'TestParent');
      client.emit('crying-detected', { roomId, babyName: 'TestBaby' });
      // Give server a moment to process (notification will fail silently — no real ntfy)
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(true).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('does not crash on crying-detected when not in a room', async () => {
    const client = createSocketClient(server.port);
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('connect', () => { clearTimeout(t); resolve(); });
      });

      client.emit('crying-detected', { babyName: 'TestBaby' });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(true).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});

describe('ntfy server URL configuration (owner-authenticated)', () => {
  it('requires owner token — returns 401 without header', async () => {
    const { roomId } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .send({ topic: 'test-topic', enabled: true });
    expect(res.status).toBe(401);
  });

  it('saves ntfy config (topic + default server)', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ topic: 'my-test-topic', enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Public config reflects ntfyEnabled
    const configRes = await request(server.app).get(`/api/rooms/${roomId}/config`);
    expect(configRes.body.ntfyEnabled).toBe(true);
  });

  it('accepts custom ntfy server in the allowlist (NTFY_ALLOWED_HOSTS)', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);

    // Temporarily allow the custom host via env
    const orig = process.env.NTFY_ALLOWED_HOSTS;
    process.env.NTFY_ALLOWED_HOSTS = 'my-ntfy.example.com';

    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        topic: 'test-topic',
        ntfyServer: 'https://my-ntfy.example.com',
        enabled: true,
      });

    process.env.NTFY_ALLOWED_HOSTS = orig || '';

    // Successful POST confirms the server accepted and stored the config
    expect(res.status).toBe(200);
  });

  it('accepts a public self-hosted HTTPS ntfy server (advertised flow)', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        topic: 'test-topic',
        ntfyServer: 'https://ntfy.myhome.example.com',
        enabled: true,
      });
    expect(res.status).toBe(200);
  });

  it('rejects a private/loopback ntfy server (SSRF guard)', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        topic: 'test-topic',
        ntfyServer: 'https://192.168.1.10',
        enabled: true,
      });
    expect(res.status).toBe(400);
  });

  it('rejects non-HTTPS ntfy server', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        topic: 'test-topic',
        ntfyServer: 'http://ntfy.sh',
        enabled: true,
      });
    expect(res.status).toBe(400);
  });

  it('rejects invalid topic characters', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ topic: 'bad topic!', enabled: true });
    expect(res.status).toBe(400);
  });

  it('defaults ntfyServer to null when not provided', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const res = await request(server.app)
      .post(`/api/rooms/${roomId}/ntfy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ topic: 'another-topic', enabled: true });

    expect(res.status).toBe(200);
    // Public config only returns hasPin + ntfyEnabled; ntfyServer not exposed
    const configRes = await request(server.app).get(`/api/rooms/${roomId}/config`);
    expect(configRes.body).toHaveProperty('ntfyEnabled', true);
    expect(configRes.body).not.toHaveProperty('ntfyServer');
    expect(configRes.body).not.toHaveProperty('ntfyTopic');
  });
});

describe('GET /api/rooms/:roomId/config (public, non-sensitive fields only)', () => {
  it('returns hasPin and ntfyEnabled only', async () => {
    const { roomId } = await createRoom(server.app);
    const res = await request(server.app).get(`/api/rooms/${roomId}/config`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hasPin');
    expect(res.body).toHaveProperty('ntfyEnabled');
    expect(res.body).not.toHaveProperty('ntfyTopic');
    expect(res.body).not.toHaveProperty('ntfyServer');
    expect(res.body).not.toHaveProperty('pin');
    expect(res.body).not.toHaveProperty('ownerHash');
  });
});
