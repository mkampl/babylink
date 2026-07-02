// ESP32 WebSocket proxy integration tests.
//
// The classic raw-PCM audio path has been removed; the server no longer
// processes binary audio frames. Audio reaches parents via WebRTC (S3 path).
// These tests cover the JSON control-message path and lifecycle events.

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

describe('ESP32 WebSocket proxy', () => {
  it('registers successfully', async () => {
    const esp32 = makeESP32();
    const response = await esp32.register(VALID_ROOM_ID, 'Test Baby');
    expect(response.type).toBe('registered');
    expect(response.id).toMatch(/^esp32_/);
    expect(response.message).toContain('Successfully registered');
  });

  it('registration without roomId returns error', async () => {
    const esp32 = makeESP32();
    await esp32.waitForOpen();
    const errorPromise = esp32.waitForMessage('error');
    esp32.ws.send(JSON.stringify({ type: 'register' }));
    const error = await errorPromise;
    expect(error.message).toContain('roomId');
  });

  it('Socket.IO room receives participant-joined from ESP32', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const joinedPromise = waitForEvent(parent, 'participant-joined');
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'ESP32 Baby');

    const joined = await joinedPromise;
    expect(joined.role).toBe('baby');
    expect(joined.userName).toBe('ESP32 Baby');
    expect(joined.source).toBe('esp32');
  });

  it('ping receives pong response', async () => {
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'ESP32 Baby');

    const pong = await esp32.sendPing();
    expect(pong.type).toBe('pong');
    expect(pong.timestamp).toBeDefined();
  });

  it('ESP32 disconnect notifies Socket.IO room', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'ESP32 Baby');
    await new Promise(r => setTimeout(r, 100));

    const leftPromise = waitForEvent(parent, 'participant-left');
    await esp32.close();
    esp32Clients = esp32Clients.filter(c => c !== esp32);

    const leftData = await leftPromise;
    expect(leftData.role).toBe('baby');
    expect(leftData.source).toBe('esp32');
  });

  it('aggregate status reflects connected device count', async () => {
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'ESP32 Baby');
    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app).get('/api/esp32/status');
    expect(res.body.totalClients).toBe(1);
    // Public endpoint does not expose roomId, clientIp, or device details
    expect(res.body.clients).toBeUndefined();
  });

  it('status shows 0 after disconnect', async () => {
    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'ESP32 Baby');
    await new Promise(r => setTimeout(r, 100));

    await esp32.close();
    esp32Clients = esp32Clients.filter(c => c !== esp32);
    await new Promise(r => setTimeout(r, 200));

    const res = await request(server.app).get('/api/esp32/status');
    expect(res.body.totalClients).toBe(0);
  });

  it('multiple ESP32 devices can register in same room', async () => {
    const esp32a = makeESP32();
    const esp32b = makeESP32();
    await esp32a.register(VALID_ROOM_ID, 'Baby 1');
    await esp32b.register(VALID_ROOM_ID, 'Baby 2');
    await new Promise(r => setTimeout(r, 100));

    const res = await request(server.app).get('/api/esp32/status');
    expect(res.body.totalClients).toBe(2);
  });
});
