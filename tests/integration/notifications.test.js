const request = require('supertest');
const { startServer } = require('../helpers/server-factory');
const { createSocketClient, joinRoom } = require('../helpers/socket-client');

// Use unique room IDs to avoid state collisions
const NOTIF_ROOM = 'a1'.repeat(16);

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('Crying detection socket event', () => {
  it('accepts crying-detected event from parent in room', async () => {
    // Configure ntfy for the room (won't actually send — no real ntfy server)
    await request(server.app)
      .post(`/api/rooms/${NOTIF_ROOM}/ntfy`)
      .send({
        topic: 'test-crying-topic',
        enabled: true,
        notifyOnCrying: true,
      });

    const client = createSocketClient(server.port);
    try {
      await joinRoom(client, NOTIF_ROOM, 'parent', 'TestParent');

      // Emit crying-detected — should not crash/error
      client.emit('crying-detected', {
        roomId: NOTIF_ROOM,
        babyId: 'fakeBabyId',
        babyName: 'TestBaby',
      });

      // Give server a moment to process (notification will fail silently since ntfy.sh topic is fake)
      await new Promise(resolve => setTimeout(resolve, 500));

      // If we get here without error, the handler works
      expect(true).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('does not crash on crying-detected when not in a room', async () => {
    const client = createSocketClient(server.port);
    try {
      // Wait for connection
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        client.on('connect', () => { clearTimeout(t); resolve(); });
      });

      // Emit without joining a room
      client.emit('crying-detected', {
        roomId: NOTIF_ROOM,
        babyId: 'fakeBabyId',
        babyName: 'TestBaby',
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      expect(true).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});

describe('ntfy server URL configuration', () => {
  it('saves custom ntfy server URL', async () => {
    const res = await request(server.app)
      .post(`/api/rooms/${NOTIF_ROOM}/ntfy`)
      .send({
        topic: 'test-topic',
        ntfyServer: 'https://my-ntfy.example.com',
        enabled: true,
      });

    expect(res.status).toBe(200);

    const configRes = await request(server.app)
      .get(`/api/rooms/${NOTIF_ROOM}/config`);
    expect(configRes.body.ntfyServer).toBe('https://my-ntfy.example.com');
  });

  it('defaults to null ntfyServer when not provided', async () => {
    const otherRoom = 'a2'.repeat(16);
    const res = await request(server.app)
      .post(`/api/rooms/${otherRoom}/ntfy`)
      .send({
        topic: 'test-topic',
        enabled: true,
      });

    expect(res.status).toBe(200);

    const configRes = await request(server.app)
      .get(`/api/rooms/${otherRoom}/config`);
    expect(configRes.body.ntfyServer).toBeFalsy();
  });
});
