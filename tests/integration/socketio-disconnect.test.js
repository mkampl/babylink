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

describe('Socket.IO disconnect', () => {
  it('other participants receive participant-left on disconnect', async () => {
    const clientA = makeClient();
    const clientB = makeClient();
    await joinRoom(clientA, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(clientB, VALID_ROOM_ID, 'baby', 'Emma');

    // Save the ID before disconnect (socket.io clears it on disconnect)
    const clientBId = clientB.id;

    const leftPromise = waitForEvent(clientA, 'participant-left');
    clientB.disconnect();
    clients = clients.filter(c => c !== clientB);

    const leftData = await leftPromise;
    expect(leftData.role).toBe('baby');
    expect(leftData.socketId).toBe(clientBId);
  });

  it('participant-left includes remaining participants', async () => {
    const clientA = makeClient();
    const clientB = makeClient();
    await joinRoom(clientA, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(clientB, VALID_ROOM_ID, 'baby', 'Emma');

    const leftPromise = waitForEvent(clientA, 'participant-left');
    clientB.disconnect();
    clients = clients.filter(c => c !== clientB);

    const leftData = await leftPromise;
    expect(leftData.participants.length).toBe(1);
    expect(leftData.participants[0].socketId).toBe(clientA.id);
  });

  it('empty room is deleted after last participant leaves', async () => {
    const client = makeClient();
    await joinRoom(client, VALID_ROOM_ID, 'baby', 'Emma');
    expect(server.rooms.size).toBe(1);

    client.disconnect();
    clients = clients.filter(c => c !== client);
    await new Promise(r => setTimeout(r, 300));

    expect(server.rooms.size).toBe(0);
  });

  it('room persists if participants remain', async () => {
    const clientA = makeClient();
    const clientB = makeClient();
    await joinRoom(clientA, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(clientB, VALID_ROOM_ID, 'baby', 'Emma');

    const leftPromise = waitForEvent(clientA, 'participant-left');
    clientB.disconnect();
    clients = clients.filter(c => c !== clientB);
    await leftPromise;

    expect(server.rooms.size).toBe(1);
  });

  it('reconnection to same room works', async () => {
    const client1 = makeClient();
    await joinRoom(client1, VALID_ROOM_ID, 'baby', 'Emma');
    client1.disconnect();
    clients = clients.filter(c => c !== client1);
    await new Promise(r => setTimeout(r, 200));

    const client2 = makeClient();
    const state = await joinRoom(client2, VALID_ROOM_ID, 'baby', 'Emma');
    expect(state.participants.length).toBe(1);
  });

  it('disconnect without joining room does not crash', async () => {
    const client = makeClient();
    await waitForEvent(client, 'connect');
    client.disconnect();
    clients = clients.filter(c => c !== client);
    await new Promise(r => setTimeout(r, 200));
    // If we get here without error, the test passes
  });
});
