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

describe('baby-status (battery)', () => {
  it('relays a baby battery report to the room with its socketId', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const statusPromise = waitForEvent(parent, 'baby-status');
    baby.emit('baby-status', { battery: 64, charging: true });
    const status = await statusPromise;
    expect(status.socketId).toBe(baby.id);
    expect(status.battery).toBe(64);
    expect(status.charging).toBe(true);
  });

  it('clamps and rounds an out-of-range battery value', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const statusPromise = waitForEvent(parent, 'baby-status');
    baby.emit('baby-status', { battery: 142.7, charging: 'yes' });
    const status = await statusPromise;
    expect(status.battery).toBe(100);
    expect(status.charging).toBe(true);
  });

  it('relays a negative battery as null (unknown → "--%")', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const statusPromise = waitForEvent(parent, 'baby-status');
    baby.emit('baby-status', { battery: -1 }); // sense active but unreadable
    const status = await statusPromise;
    expect(status.battery).toBeNull();
  });

  it('ignores a report with no battery field', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    let got = false;
    parent.on('baby-status', () => { got = true; });
    baby.emit('baby-status', { charging: true });
    await new Promise(r => setTimeout(r, 200));
    expect(got).toBe(false);
  });

  it('is not echoed back to the reporting baby', async () => {
    const baby = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');

    let echoed = false;
    baby.on('baby-status', () => { echoed = true; });
    baby.emit('baby-status', { battery: 50 });
    await new Promise(r => setTimeout(r, 200));
    expect(echoed).toBe(false);
  });

  it('surfaces the last battery in room-state for a late-joining parent', async () => {
    const baby = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    baby.emit('baby-status', { battery: 33, charging: false });
    await new Promise(r => setTimeout(r, 100));

    const parent = makeClient();
    const roomState = await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');
    const babyEntry = roomState.participants.find(p => p.socketId === baby.id);
    expect(babyEntry).toBeDefined();
    expect(babyEntry.battery).toBe(33);
    expect(babyEntry.charging).toBe(false);
  });
});
