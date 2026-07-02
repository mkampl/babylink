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
