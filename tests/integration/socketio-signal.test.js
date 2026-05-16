const { startServer } = require('../helpers/server-factory');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } = require('../helpers/socket-client');
const { VALID_ROOM_ID } = require('../helpers/constants');

let server;
let clients = [];

beforeAll(async () => {
  server = await startServer();
});

afterEach(async () => {
  await Promise.all(clients.map(c => disconnectClient(c)));
  clients = [];
});

afterAll(async () => {
  await server.close();
});

function makeClient() {
  const c = createSocketClient(server.port);
  clients.push(c);
  return c;
}

describe('Socket.IO signaling', () => {
  it('broadcasts offer to room participants', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const signalPromise = waitForEvent(parent, 'signal');
    baby.emit('signal', { offer: { type: 'offer', sdp: 'test-sdp' } });
    const signal = await signalPromise;
    expect(signal.offer).toBeDefined();
    expect(signal.from).toBe('baby');
    expect(signal.fromSocketId).toBe(baby.id);
    expect(signal.fromUserName).toBe('Emma');
  });

  it('broadcasts answer to room participants', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const signalPromise = waitForEvent(baby, 'signal');
    parent.emit('signal', { answer: { type: 'answer', sdp: 'test-sdp' } });
    const signal = await signalPromise;
    expect(signal.answer).toBeDefined();
    expect(signal.from).toBe('parent');
  });

  it('broadcasts ICE candidate', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const signalPromise = waitForEvent(parent, 'signal');
    baby.emit('signal', { ice: { candidate: 'test-candidate' } });
    const signal = await signalPromise;
    expect(signal.ice).toBeDefined();
  });

  it('unicast when to is specified', async () => {
    const baby = makeClient();
    const parent1 = makeClient();
    const parent2 = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent1, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(parent2, VALID_ROOM_ID, 'parent', 'Dad');

    let parent2Received = false;
    parent2.on('signal', () => { parent2Received = true; });

    const signalPromise = waitForEvent(parent1, 'signal');
    baby.emit('signal', { offer: { type: 'offer' }, to: parent1.id });
    await signalPromise;

    // Wait a bit to confirm parent2 didn't get it
    await new Promise(r => setTimeout(r, 200));
    expect(parent2Received).toBe(false);
  });

  it('signal includes from metadata', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const signalPromise = waitForEvent(parent, 'signal');
    baby.emit('signal', { offer: {} });
    const signal = await signalPromise;
    expect(signal.from).toBe('baby');
    expect(signal.fromSocketId).toBe(baby.id);
    expect(signal.fromUserName).toBe('Emma');
  });

  it('signal is not sent back to sender', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    let babyReceived = false;
    baby.on('signal', () => { babyReceived = true; });

    baby.emit('signal', { offer: {} });

    // Wait to confirm baby didn't get own signal
    await new Promise(r => setTimeout(r, 300));
    expect(babyReceived).toBe(false);
  });

  it('signal from socket not in room is silently dropped', async () => {
    const orphan = makeClient();
    await waitForEvent(orphan, 'connect');

    // Should not crash
    orphan.emit('signal', { offer: {} });
    await new Promise(r => setTimeout(r, 200));
    // If we get here without error, the test passes
  });

  it('signal with arbitrary data passes through', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const signalPromise = waitForEvent(parent, 'signal');
    baby.emit('signal', { offer: {}, customField: 'test-value' });
    const signal = await signalPromise;
    expect(signal.customField).toBe('test-value');
  });
});
