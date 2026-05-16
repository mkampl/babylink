const request = require('supertest');
const { startServer } = require('../helpers/server-factory');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } = require('../helpers/socket-client');
const { createESP32Client } = require('../helpers/esp32-client');
const { VALID_ROOM_ID } = require('../helpers/constants');

let server;
let clients = [];
let esp32Clients = [];

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await Promise.all(clients.map(c => disconnectClient(c)));
  await Promise.all(esp32Clients.map(c => c.close()));
  await server.close();
});

function makeClient() {
  const c = createSocketClient(server.port);
  clients.push(c);
  return c;
}

function makeESP32() {
  const c = createESP32Client(server.port);
  esp32Clients.push(c);
  return c;
}

describe('Smoke tests — critical path', () => {
  it('1. health check returns healthy', async () => {
    const res = await request(server.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  it('2. home page loads', async () => {
    const res = await request(server.app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('BabyLink');
  });

  it('3. WebRTC config is available', async () => {
    const res = await request(server.app).get('/api/config/webrtc');
    expect(res.status).toBe(200);
    expect(res.body.iceServers.length).toBeGreaterThan(0);
  });

  it('4. valid room serves role selection', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}`);
    expect(res.status).toBe(200);
  });

  it('5. valid room with role serves WebRTC page', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}?role=baby`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('6. POST room redirects correctly', async () => {
    const res = await request(server.app)
      .post(`/${VALID_ROOM_ID}`)
      .send('role=parent');
    expect(res.status).toBe(302);
  });

  it('7. invalid room ID rejected', async () => {
    const res = await request(server.app).get('/invalid-room');
    expect(res.status).toBe(400);
  });

  it('8. Socket.IO client can join room', async () => {
    const client = makeClient();
    const state = await joinRoom(client, VALID_ROOM_ID, 'baby', 'Emma');
    expect(state.participants).toBeDefined();
    expect(state.participants.length).toBe(1);
  });

  it('9. second client sees first (participant-joined)', async () => {
    const parent = makeClient();
    const joinedPromise = waitForEvent(clients[0], 'participant-joined');
    const state = await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    await joinedPromise;
    expect(state.participants.length).toBe(2);
  });

  it('10. WebRTC signal routes between clients', async () => {
    // clients[0] = baby (Emma), clients[1] = parent (Mom)
    const signalPromise = waitForEvent(clients[1], 'signal');
    clients[0].emit('signal', { offer: { type: 'offer', sdp: 'test' } });
    const signal = await signalPromise;
    expect(signal.offer).toBeDefined();
    expect(signal.from).toBe('baby');
  });

  it('11. client disconnect cleans up', async () => {
    const leftPromise = waitForEvent(clients[0], 'participant-left');
    clients[1].disconnect();
    const leftData = await leftPromise;
    expect(leftData.role).toBe('parent');
    clients = [clients[0]]; // Keep only baby
  });

  it('12. last client disconnect deletes room', async () => {
    clients[0].disconnect();
    clients = [];
    await new Promise(r => setTimeout(r, 300));

    const res = await request(server.app).get('/health');
    expect(res.body.rooms).toBe(0);
  });

  it('13. ESP32 device registers', async () => {
    const esp32 = makeESP32();
    const response = await esp32.register(VALID_ROOM_ID, 'ESP32 Baby');
    expect(response.type).toBe('registered');
    expect(response.id).toMatch(/^esp32_/);
  });

  it('14. ESP32 audio forwarded to room', async () => {
    // Join a parent to the room
    const parent = makeClient();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    await new Promise(r => setTimeout(r, 100));

    const audioPromise = waitForEvent(parent, 'esp32-audio');
    esp32Clients[0].sendAudio();
    const audio = await audioPromise;
    expect(audio.fromName).toBe('ESP32 Baby');
  });

  it('15. ESP32 disconnect cleans up', async () => {
    const leftPromise = waitForEvent(clients[0], 'participant-left');
    await esp32Clients[0].close();
    esp32Clients = [];
    const leftData = await leftPromise;
    expect(leftData.source).toBe('esp32');
  });

  it('16. static assets served', async () => {
    const res = await request(server.app).get('/style.css');
    expect(res.status).toBe(200);
  });

  it('17. 404 for unknown paths', async () => {
    const res = await request(server.app).get('/does/not/exist');
    expect(res.status).toBe(404);
  });
});
