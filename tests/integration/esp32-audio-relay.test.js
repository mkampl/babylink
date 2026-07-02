// ESP32 S3 audio path: raw PCM frames arrive on the /esp32-baby WS as binary
// and must be relayed to every parent in the room as 'esp32-audio'. Audio
// frames are high-rate (~15/s) and must NOT count against the control-message
// rate limiter, which guards register/signal/ping against flooding.

const { startServer } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } =
  require('../helpers/socket-client');
const { VALID_ROOM_ID } = require('../helpers/constants');

let server;
let esp32Clients = [];
let socketClients = [];

beforeAll(async () => { server = await startServer(); });

afterEach(async () => {
  await Promise.all(esp32Clients.map(c => c.close()));
  esp32Clients = [];
  await Promise.all(socketClients.map(c => disconnectClient(c)));
  socketClients = [];
});

afterAll(async () => { await server.close(); });

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

// One 1024-sample PCM chunk (2048 bytes), the firmware's frame size.
function pcmFrame(fill = 1234) {
  const buf = Buffer.alloc(2048);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(fill & 0x7fff, i);
  return buf;
}

describe('ESP32 S3 audio relay', () => {
  it('relays a binary PCM frame to parents as esp32-audio', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const esp32 = makeESP32();
    const reg = await esp32.register(VALID_ROOM_ID, 'S3 Baby',
                                     'aa:bb:cc:dd:ee:21',
                                     { device_type: 'esp32-s3' });
    await new Promise(r => setTimeout(r, 100));

    const audioArrived = waitForEvent(parent, 'esp32-audio');
    esp32.sendAudio(pcmFrame());

    const ev = await audioArrived;
    expect(ev.fromId).toBe(reg.id);
    expect(ev.deviceType).toBe('esp32-s3');
    expect(ev.sampleRate).toBe(16000);
    // audio survives socket.io serialization as a Buffer/typed payload
    const bytes = ev.audio && (ev.audio.data ? ev.audio.data : ev.audio);
    expect(bytes.length || bytes.byteLength).toBe(2048);
  });

  it('does not relay audio to a different room', async () => {
    const other = makeSocket();
    await joinRoom(other, 'ffffffffffffffffffffffffffffffff', 'parent', 'Dad');

    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'S3 Baby', 'aa:bb:cc:dd:ee:22',
                         { device_type: 'esp32-s3' });
    await new Promise(r => setTimeout(r, 100));

    let leaked = false;
    other.on('esp32-audio', () => { leaked = true; });
    for (let i = 0; i < 5; i++) esp32.sendAudio(pcmFrame(i));
    await new Promise(r => setTimeout(r, 150));
    expect(leaked).toBe(false);
  });

  it('audio frames are exempt from the control-message rate limit', async () => {
    const parent = makeSocket();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const esp32 = makeESP32();
    await esp32.register(VALID_ROOM_ID, 'S3 Baby', 'aa:bb:cc:dd:ee:23',
                         { device_type: 'esp32-s3' });
    await new Promise(r => setTimeout(r, 100));

    let received = 0;
    parent.on('esp32-audio', () => { received++; });

    // Far more than the control-message cap (60/10s) — the device must stay
    // connected and every frame must be relayed.
    const N = 200;
    for (let i = 0; i < N; i++) esp32.sendAudio(pcmFrame(i));
    await new Promise(r => setTimeout(r, 400));

    expect(esp32.ws.readyState).toBe(1); // OPEN — not dropped by rate limiter
    expect(received).toBe(N);
  });
});
