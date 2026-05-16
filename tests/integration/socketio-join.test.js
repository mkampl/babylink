const { startServer } = require('../helpers/server-factory');
const { createSocketClient, waitForEvent, joinRoom, disconnectClient } = require('../helpers/socket-client');
const { VALID_ROOM_ID, VALID_ROOM_ID_2 } = require('../helpers/constants');

let server;
let clients = [];

beforeAll(async () => {
  server = await startServer();
});

afterEach(async () => {
  // Disconnect all clients created during the test
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

describe('Socket.IO join', () => {
  it('successfully joins room with valid data', async () => {
    const client = makeClient();
    const state = await joinRoom(client, VALID_ROOM_ID, 'baby', 'Emma');
    expect(state.participants).toBeDefined();
    expect(state.participants.length).toBeGreaterThanOrEqual(1);
  });

  it('room-state contains correct participant info', async () => {
    const client = makeClient();
    const state = await joinRoom(client, VALID_ROOM_ID, 'baby', 'Emma');
    const me = state.participants.find(p => p.socketId === client.id);
    expect(me).toBeDefined();
    expect(me.role).toBe('baby');
    expect(me.userName).toBe('Emma');
    expect(me.source).toBe('socketio');
  });

  it('other participants receive participant-joined', async () => {
    const clientA = makeClient();
    await joinRoom(clientA, VALID_ROOM_ID, 'parent', 'Mom');

    const joinedPromise = waitForEvent(clientA, 'participant-joined');
    const clientB = makeClient();
    await joinRoom(clientB, VALID_ROOM_ID, 'baby', 'Emma');

    const joinedData = await joinedPromise;
    expect(joinedData.role).toBe('baby');
    expect(joinedData.userName).toBe('Emma');
    expect(joinedData.participants).toBeDefined();
  });

  it('participant-joined includes updated participants list', async () => {
    const clientA = makeClient();
    await joinRoom(clientA, VALID_ROOM_ID, 'parent', 'Mom');

    const joinedPromise = waitForEvent(clientA, 'participant-joined');
    const clientB = makeClient();
    await joinRoom(clientB, VALID_ROOM_ID, 'baby', 'Emma');

    const joinedData = await joinedPromise;
    expect(joinedData.participants.length).toBe(2);
  });

  it('joins without userName defaults to role name', async () => {
    const client = makeClient();
    const state = await joinRoom(client, VALID_ROOM_ID, 'baby');
    const me = state.participants.find(p => p.socketId === client.id);
    expect(me.userName).toBe('baby');
  });

  it('multiple clients can join same room', async () => {
    const c1 = makeClient();
    const c2 = makeClient();
    const c3 = makeClient();
    await joinRoom(c1, VALID_ROOM_ID, 'baby', 'B1');
    await joinRoom(c2, VALID_ROOM_ID, 'baby', 'B2');
    const state = await joinRoom(c3, VALID_ROOM_ID, 'parent', 'P1');
    expect(state.participants.length).toBe(3);
  });

  it('clients in different rooms are isolated', async () => {
    const clientA = makeClient();
    await joinRoom(clientA, VALID_ROOM_ID, 'parent', 'Mom');

    // clientA should NOT receive participant-joined from room 2
    let received = false;
    clientA.on('participant-joined', () => { received = true; });

    const clientB = makeClient();
    await joinRoom(clientB, VALID_ROOM_ID_2, 'baby', 'Emma');

    // Small wait to confirm no event was emitted
    await new Promise(r => setTimeout(r, 200));
    expect(received).toBe(false);
  });

  it('rejects join with missing roomId', async () => {
    const client = makeClient();
    await waitForEvent(client, 'connect');
    const errorPromise = waitForEvent(client, 'error');
    client.emit('join', { role: 'baby' });
    const err = await errorPromise;
    expect(err.message).toContain('room ID');
  });

  it('rejects join with invalid roomId format', async () => {
    const client = makeClient();
    await waitForEvent(client, 'connect');
    const errorPromise = waitForEvent(client, 'error');
    client.emit('join', { roomId: 'short', role: 'baby' });
    const err = await errorPromise;
    expect(err.message).toContain('room ID');
  });

  it('rejects join with missing role', async () => {
    const client = makeClient();
    await waitForEvent(client, 'connect');
    const errorPromise = waitForEvent(client, 'error');
    client.emit('join', { roomId: VALID_ROOM_ID });
    const err = await errorPromise;
    expect(err.message).toContain('role');
  });

  it('rejects join with invalid role', async () => {
    const client = makeClient();
    await waitForEvent(client, 'connect');
    const errorPromise = waitForEvent(client, 'error');
    client.emit('join', { roomId: VALID_ROOM_ID, role: 'watcher' });
    const err = await errorPromise;
    expect(err.message).toContain('role');
  });

  it('rejects join with userName over 50 chars', async () => {
    const client = makeClient();
    await waitForEvent(client, 'connect');
    const errorPromise = waitForEvent(client, 'error');
    client.emit('join', { roomId: VALID_ROOM_ID, role: 'baby', userName: 'x'.repeat(51) });
    const err = await errorPromise;
    expect(err.message).toContain('user name');
  });
});
