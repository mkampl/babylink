// Room scoping: a socket may only reach participants of the room it joined.
// Covers the capacity-rejection leak (rejected sockets must not stay in the
// room), cross-room signal relay in both directions (browser ↔ browser and
// browser ↔ ESP32), 

const { startServer } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } =
  require('../helpers/socket-client');
const { VALID_ROOM_ID, VALID_ROOM_ID_2 } = require('../helpers/constants');

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

// Resolves true if `event` arrives on `client` within ms, else false.
function arrives(client, event, ms = 300) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { client.off(event, h); resolve(false); }, ms);
    const h = () => { clearTimeout(t); resolve(true); };
    client.once(event, h);
  });
}

function joinExpectError(client, data) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    client.once('error', (e) => { clearTimeout(t); resolve(e); });
    client.once('room-state', () => { clearTimeout(t); reject(new Error('joined unexpectedly')); });
    const go = () => client.emit('join', data);
    if (client.connected) go(); else client.once('connect', go);
  });
}

describe('capacity rejection (B3)', () => {
  it('a socket rejected as "Room is full" is not left inside the room', async () => {
    const roomId = 'd'.repeat(32);
    for (let i = 0; i < 5; i++) {
      await joinRoom(makeSocket(), roomId, 'baby', `Baby${i}`);
    }
    const parent = makeSocket();
    await joinRoom(parent, roomId, 'parent', 'Mom');

    const sixth = makeSocket();
    const err = await joinExpectError(sixth, { roomId, role: 'baby', userName: 'Baby5' });
    expect(err.message).toContain('full');
    expect(err.code).toBe('ROOM_FULL');

    // The rejected socket must not receive room broadcasts…
    const leak = arrives(sixth, 'participant-joined');
    await joinRoom(makeSocket(), roomId, 'parent', 'Dad');
    expect(await leak).toBe(false);

    // …nor be able to signal into the room.
    const got = arrives(parent, 'signal');
    sixth.emit('signal', { offer: { type: 'offer', sdp: 'x' } });
    expect(await got).toBe(false);
  });
});

describe('signal relay is room-scoped (S1)', () => {
  it('a unicast signal to a socket in another room is dropped', async () => {
    const victim = makeSocket();
    await joinRoom(victim, VALID_ROOM_ID, 'parent', 'Victim');
    const attacker = makeSocket();
    await joinRoom(attacker, VALID_ROOM_ID_2, 'baby', 'Attacker');

    const got = arrives(victim, 'signal');
    attacker.emit('signal', { offer: { type: 'offer', sdp: 'evil' }, to: victim.id });
    expect(await got).toBe(false);
  });

  it('a unicast signal inside the same room still arrives', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    const baby = makeSocket();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');

    const got = waitForEvent(parent, 'signal');
    baby.emit('signal', { offer: { type: 'offer', sdp: 'ok' }, to: parent.id });
    const sig = await got;
    expect(sig.fromSocketId).toBe(baby.id);
  });

  it('a browser cannot signal an ESP32 registered in another room', async () => {
    const esp = makeESP32();
    const reg = await esp.register(VALID_ROOM_ID, 'S3', 'aa:bb:cc:dd:ee:51');
    const attacker = makeSocket();
    await joinRoom(attacker, VALID_ROOM_ID_2, 'parent', 'Attacker');

    let received = false;
    esp.ws.on('message', (d) => {
      try { if (JSON.parse(d.toString()).type === 'signal') received = true; } catch { /* binary */ }
    });
    attacker.emit('signal', { to: reg.id, offer: 'v=0' });
    await new Promise(r => setTimeout(r, 300));
    expect(received).toBe(false);
  });

  it('an ESP32 cannot signal a browser in another room', async () => {
    const victim = makeSocket();
    await joinRoom(victim, VALID_ROOM_ID_2, 'parent', 'Victim');
    const esp = makeESP32();
    await esp.register(VALID_ROOM_ID, 'S3', 'aa:bb:cc:dd:ee:52');

    const got = arrives(victim, 'signal');
    esp.ws.send(JSON.stringify({ type: 'signal', to: victim.id, offer: 'v=0' }));
    expect(await got).toBe(false);
  });

  it('an ESP32 can still signal a browser in its own room', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    const esp = makeESP32();
    const reg = await esp.register(VALID_ROOM_ID, 'S3', 'aa:bb:cc:dd:ee:53');

    const got = waitForEvent(parent, 'signal');
    esp.ws.send(JSON.stringify({ type: 'signal', to: parent.id, offer: 'v=0' }));
    const sig = await got;
    expect(sig.fromSocketId).toBe(reg.id);
  });
});

