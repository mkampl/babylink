// Branch 4 — server WebRTC signaling bridge ESP32 ↔ browser.
//
// The server is a pure relay (does not inspect SDP/ICE). These tests
// verify routing in both directions:
//   1. Browser → ESP32: socket emits 'signal' with to=esp32_X.
//      Server routes via esp32Proxy.relaySignalToESP() — frame arrives
//      on the ESP WS as {type:"signal", ...}.
//   2. ESP32 → Browser: ESP sends {type:"signal", to:<browserId>, ...}
//      over WS. Server forwards via Socket.IO 'signal' event.

const { startServer } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } =
  require('../helpers/socket-client');
const { VALID_ROOM_ID } = require('../helpers/constants');

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

// Wait for a WS frame on the ESP client that matches a predicate. The
// existing createESP32Client only has waitForMessage(type) — but the
// signal frame is type='signal'. That works for us.

describe('WebRTC signaling bridge ESP32 ↔ browser', () => {
  it('browser → ESP: signal with to=esp32_X arrives on ESP WS', async () => {
    const esp32 = makeESP32();
    const reg = await esp32.register(VALID_ROOM_ID, 'S3 Baby',
                                     'aa:bb:cc:dd:ee:11',
                                     { device_type: 'esp32-s3' });
    const espId = reg.id;

    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const signalArrived = esp32.waitForMessage('signal');
    parent.emit('signal', {
      to: espId,
      offer: 'v=0\nfake-sdp\n',
    });

    const frame = await signalArrived;
    expect(frame.type).toBe('signal');
    expect(frame.offer).toBe('v=0\nfake-sdp\n');
    expect(frame.fromSocketId).toBe(parent.id);
    // Server stamps from/fromUserName (mirrors the browser-side path):
    expect(frame.fromUserName).toBe('Mom');
  });

  it('ESP → browser: ESP-sent signal arrives via Socket.IO', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'S3 Baby', 'aa:bb:cc:dd:ee:12',
                         { device_type: 'esp32-s3' });
    // Wait briefly for the registered ack to propagate so esp32Info is
    // captured by the closure on the server side.
    await new Promise(r => setTimeout(r, 100));

    const signalArrived = waitForEvent(parent, 'signal');
    esp32.ws.send(JSON.stringify({
      type: 'signal',
      to: parent.id,
      answer: 'v=0\nfake-answer\n',
    }));

    const ev = await signalArrived;
    expect(ev.answer).toBe('v=0\nfake-answer\n');
    expect(ev.from).toBe('baby');
    expect(ev.fromSocketId).toMatch(/^esp32_/);
    expect(ev.fromUserName).toBe('S3 Baby');
  });

  it('ICE candidates round-trip through the bridge', async () => {
    const esp32 = makeESP32();
    const reg = await esp32.register(VALID_ROOM_ID, 'S3 ICE',
                                     'aa:bb:cc:dd:ee:13',
                                     { device_type: 'esp32-s3' });
    const espId = reg.id;
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    await new Promise(r => setTimeout(r, 50));

    // Browser → ESP
    const espFrame = esp32.waitForMessage('signal');
    parent.emit('signal', {
      to: espId,
      ice: { candidate: 'candidate:1', sdpMLineIndex: 0 },
    });
    const f1 = await espFrame;
    expect(f1.ice.candidate).toBe('candidate:1');

    // ESP → Browser
    const browserSignal = waitForEvent(parent, 'signal');
    esp32.ws.send(JSON.stringify({
      type: 'signal',
      to: parent.id,
      ice: { candidate: 'candidate:2', sdpMLineIndex: 0 },
    }));
    const ev = await browserSignal;
    expect(ev.ice.candidate).toBe('candidate:2');
    expect(ev.fromSocketId).toBe(espId);
  });

  it('browser-to-browser signal still routes via Socket.IO (no regression)', async () => {
    const mom = makeSocket();
    const dad = makeSocket();
    await joinRoom(mom, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(dad, VALID_ROOM_ID, 'parent', 'Dad');

    const arrived = waitForEvent(dad, 'signal');
    mom.emit('signal', { to: dad.id, offer: 'sdp:browser-to-browser' });
    const ev = await arrived;
    expect(ev.offer).toBe('sdp:browser-to-browser');
    expect(ev.fromSocketId).toBe(mom.id);
  });

  it('signal to non-existent ESP32 is silently dropped (logged, not thrown)', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    // Should not throw or crash the socket.
    parent.emit('signal', {
      to: 'esp32_deadbeefdead',
      offer: 'sdp:nowhere',
    });
    // If we reach here without the connection dying, success.
    await new Promise(r => setTimeout(r, 50));
    expect(parent.connected).toBe(true);
  });
});
