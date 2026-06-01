// Branch 1 — device_type round-trip for the new XIAO ESP32-S3 firmware.
//
// Verifies that:
//   1. A register frame carrying device_type='esp32-s3' surfaces in
//      getRoomParticipants() with the matching deviceType field, and in
//      the participant-joined Socket.IO event.
//   2. Legacy clients (no device_type field) default to 'esp32-classic'
//      so we don't break the existing classic ESP32 firmware.

const { startServer } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } = require('../helpers/socket-client');
const { VALID_ROOM_ID } = require('../helpers/constants');
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
  it('s3 register payload propagates to /api/esp32/devices', async () => {
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'XIAO S3 Test', 'aa:bb:cc:dd:ee:01', { device_type: 'esp32-s3' });
    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app)
      .get(`/api/rooms/${encodeURIComponent(VALID_ROOM_ID)}/esp32/devices`);
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].deviceType).toBe('esp32-s3');
    expect(res.body.devices[0].name).toBe('XIAO S3 Test');
  });

  it('legacy register payload (no device_type) defaults to esp32-classic', async () => {
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'Classic Baby', 'aa:bb:cc:dd:ee:02');
    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app)
      .get(`/api/rooms/${encodeURIComponent(VALID_ROOM_ID)}/esp32/devices`);
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].deviceType).toBe('esp32-classic');
  });

  it('participant-joined event carries deviceType for s3 clients', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const joinedPromise = waitForEvent(parent, 'participant-joined');
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'XIAO S3 Test', 'aa:bb:cc:dd:ee:03', { device_type: 'esp32-s3' });

    const joined = await joinedPromise;
    expect(joined.role).toBe('baby');
    expect(joined.source).toBe('esp32');
    expect(joined.deviceType).toBe('esp32-s3');

    const s3Entry = joined.participants.find(p => p.source === 'esp32');
    expect(s3Entry).toBeDefined();
    expect(s3Entry.deviceType).toBe('esp32-s3');
  });

  it('both hardware generations coexist in the same room', async () => {
    const classic = makeESP32();
    await classic.register(VALID_ROOM_ID, 'Classic', 'aa:bb:cc:dd:ee:04');

    const s3 = makeESP32();
    await s3.register(VALID_ROOM_ID, 'S3', 'aa:bb:cc:dd:ee:05', { device_type: 'esp32-s3' });

    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app)
      .get(`/api/rooms/${encodeURIComponent(VALID_ROOM_ID)}/esp32/devices`);
    expect(res.body.devices).toHaveLength(2);

    const types = res.body.devices.map(d => d.deviceType).sort();
    expect(types).toEqual(['esp32-classic', 'esp32-s3']);
  });
});
