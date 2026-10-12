// ESP32-S3 device_type round-trip tests.
//
// Verifies that a register frame carrying device_type='esp32-s3' surfaces
// in the devices list and participant-joined Socket.IO event.
//
// Classic ESP32 (raw PCM audio) support has been removed from the server.
// Devices that do not supply device_type in their register payload receive
// deviceType: null (no default assumed).

const { startServer, createRoom } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } = require('../helpers/socket-client');
const request = require('supertest');

let server;
let esp32Clients = [];
let socketClients = [];

beforeAll(async () => {
  server = await startServer();
});

afterEach(async () => {
  await Promise.all(esp32Clients.map(c => c.close()));
  esp32Clients = [];
  await Promise.all(socketClients.map(c => disconnectClient(c)));
  socketClients = [];
});

afterAll(async () => {
  await server.close();
});

function makeESP32() {
  const c = createESP32Client(server.port);
  esp32Clients.push(c);
  return c;
}

function makeSocket() {
  const c = createSocketClient(server.port);
  socketClients.push(c);
  return c;
}

describe('ESP32 device_type tagging', () => {
  it('s3 register payload propagates to /api/rooms/:id/esp32/devices', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const esp32 = makeESP32();
    await esp32.register(roomId, 'XIAO S3 Test', 'aa:bb:cc:dd:ee:01', { device_type: 'esp32-s3' });
    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app)
      .get(`/api/rooms/${roomId}/esp32/devices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].deviceType).toBe('esp32-s3');
    expect(res.body.devices[0].name).toBe('XIAO S3 Test');
  });

  it('register payload without device_type stores deviceType: null', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const esp32 = makeESP32();
    await esp32.register(roomId, 'Unknown Device', 'aa:bb:cc:dd:ee:02');
    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app)
      .get(`/api/rooms/${roomId}/esp32/devices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    // No default to 'esp32-classic' — server accepts but does not assume device type
    expect(res.body.devices[0].deviceType).toBeNull();
  });

  it('participant-joined event carries deviceType for s3 clients', async () => {
    const { roomId } = await createRoom(server.app);
    const parent = makeSocket();
    await joinRoom(parent, roomId, 'parent', 'Mom');

    const joinedPromise = waitForEvent(parent, 'participant-joined');
    const esp32 = makeESP32();
    await esp32.register(roomId, 'XIAO S3 Test', 'aa:bb:cc:dd:ee:03', { device_type: 'esp32-s3' });

    const joined = await joinedPromise;
    expect(joined.role).toBe('baby');
    expect(joined.source).toBe('esp32');
    expect(joined.deviceType).toBe('esp32-s3');

    const s3Entry = joined.participants.find(p => p.source === 'esp32');
    expect(s3Entry).toBeDefined();
    expect(s3Entry.deviceType).toBe('esp32-s3');
  });
});

describe('same-MAC re-register while the old socket is still open (B2)', () => {
  it('the stale socket closing later does not unregister the new registration', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const parent = makeSocket();
    await joinRoom(parent, roomId, 'parent', 'Mom');

    const MAC = 'aa:bb:cc:dd:ee:b2';
    const first = makeESP32();
    await first.register(roomId, 'Nursery', MAC);

    const left = [];
    parent.on('participant-left', (d) => left.push(d));

    // Device reboots / reconnects before the server noticed the old socket died.
    const second = makeESP32();
    const firstClosed = new Promise((r) => first.ws.once('close', r));
    await second.register(roomId, 'Nursery', MAC);
    await firstClosed;
    await new Promise((r) => setTimeout(r, 200));

    expect(left).toHaveLength(0);
    const res = await request(server.app)
      .get(`/api/rooms/${roomId}/esp32/devices`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.body.devices).toHaveLength(1);

    // Audio from the NEW socket still reaches the parent.
    const audio = waitForEvent(parent, 'esp32-audio');
    second.sendAudio();
    const frame = await audio;
    expect(frame.fromId).toBe('esp32_aabbccddeeb2');
  });
});

describe('device registration hardening (S4)', () => {
  const deviceTokens = require('../../server/device-tokens');
  beforeEach(() => deviceTokens.clear());

  function registerRaw(client, payload) {
    return (async () => {
      await client.waitForOpen();
      const reply = Promise.race([
        client.waitForMessage('registered').then((m) => ({ ok: true, m })),
        client.waitForMessage('error').then((m) => ({ ok: false, m })),
      ]);
      client.ws.send(JSON.stringify({ type: 'register', ...payload }));
      return reply;
    })();
  }

  it('rejects a malformed roomId', async () => {
    const r = await registerRaw(makeESP32(), { roomId: '../../etc', name: 'x', mac: 'aa:bb:cc:dd:ee:40' });
    expect(r.ok).toBe(false);
  });

  it('trusts the first token it sees and then requires it', async () => {
    const { roomId } = await createRoom(server.app);
    const MAC = 'aa:bb:cc:dd:ee:41';
    const TOK = '0123456789abcdef0123456789abcdef';

    const a = makeESP32();
    expect((await registerRaw(a, { roomId, name: 'N', mac: MAC, deviceToken: TOK })).ok).toBe(true);
    await a.close();
    await new Promise(r => setTimeout(r, 50));

    const b = makeESP32();
    expect((await registerRaw(b, { roomId, name: 'N', mac: MAC, deviceToken: TOK })).ok).toBe(true);
    await b.close();
    await new Promise(r => setTimeout(r, 50));

    const wrong = await registerRaw(makeESP32(), { roomId, name: 'N', mac: MAC, deviceToken: 'f'.repeat(32) });
    expect(wrong.ok).toBe(false);
    expect(wrong.m.code).toBe('DEVICE_TOKEN_MISMATCH');

    const none = await registerRaw(makeESP32(), { roomId, name: 'N', mac: MAC });
    expect(none.ok).toBe(false);
    expect(none.m.code).toBe('DEVICE_TOKEN_MISMATCH');
  });

  it('a live token-verified device cannot be kicked by a registration from another room', async () => {
    const { roomId } = await createRoom(server.app);
    const other = await createRoom(server.app);
    const MAC = 'aa:bb:cc:dd:ee:42';
    const parent = makeSocket();
    await joinRoom(parent, roomId, 'parent', 'Mom');

    const real = makeESP32();
    expect((await registerRaw(real, { roomId, name: 'Real', mac: MAC, deviceToken: 'a'.repeat(32) })).ok).toBe(true);

    const left = [];
    parent.on('participant-left', (d) => left.push(d));
    const evil = await registerRaw(makeESP32(),
      { roomId: other.roomId, name: 'Evil', mac: MAC, deviceToken: 'b'.repeat(32) });
    expect(evil.ok).toBe(false);
    await new Promise(r => setTimeout(r, 150));
    expect(left).toHaveLength(0);
    expect(real.ws.readyState).toBe(1); // still OPEN
  });

  it('devices without a token (older firmware) keep working', async () => {
    const { roomId } = await createRoom(server.app);
    const MAC = 'aa:bb:cc:dd:ee:43';
    for (let i = 0; i < 2; i++) {
      const c = makeESP32();
      expect((await registerRaw(c, { roomId, name: 'Old', mac: MAC })).ok).toBe(true);
      await c.close();
      await new Promise(r => setTimeout(r, 50));
    }
  });

  it('a token claimed in one room does not lock the device out of another room', async () => {
    const mine = await createRoom(server.app);
    const theirs = await createRoom(server.app);
    const MAC = 'aa:bb:cc:dd:ee:44';
    const squatter = makeESP32();
    expect((await registerRaw(squatter, { roomId: theirs.roomId, name: 'S', mac: MAC, deviceToken: 'c'.repeat(32) })).ok).toBe(true);
    await squatter.close();
    await new Promise(r => setTimeout(r, 50));
    const real = makeESP32();
    expect((await registerRaw(real, { roomId: mine.roomId, name: 'R', mac: MAC })).ok).toBe(true);
  });

  it('the owner can make the room forget a device token', async () => {
    const { roomId, ownerToken } = await createRoom(server.app);
    const MAC = 'aa:bb:cc:dd:ee:45';
    const a = makeESP32();
    expect((await registerRaw(a, { roomId, name: 'N', mac: MAC, deviceToken: 'd'.repeat(32) })).ok).toBe(true);
    await a.close();
    await new Promise(r => setTimeout(r, 50));

    const res = await request(server.app)
      .delete(`/api/rooms/${roomId}/esp32/esp32_aabbccddee45/token`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);

    const b = makeESP32();
    expect((await registerRaw(b, { roomId, name: 'N', mac: MAC, deviceToken: 'e'.repeat(32) })).ok).toBe(true);
  });
});
