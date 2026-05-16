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

describe('Room capacity limits', () => {
  it('rejects 6th baby (max 5)', async () => {
    // Join 5 babies
    for (let i = 0; i < 5; i++) {
      const c = makeClient();
      await joinRoom(c, VALID_ROOM_ID, 'baby', `Baby${i}`);
    }

    // 6th baby should be rejected
    const c6 = makeClient();
    await waitForEvent(c6, 'connect');
    const errorPromise = waitForEvent(c6, 'error');
    c6.emit('join', { roomId: VALID_ROOM_ID, role: 'baby', userName: 'Baby5' });
    const err = await errorPromise;
    expect(err.message).toContain('full');
  });

  it('rejects 11th parent (max 10)', async () => {
    // Join 10 parents
    for (let i = 0; i < 10; i++) {
      const c = makeClient();
      await joinRoom(c, VALID_ROOM_ID, 'parent', `Parent${i}`);
    }

    // 11th parent should be rejected
    const c11 = makeClient();
    await waitForEvent(c11, 'connect');
    const errorPromise = waitForEvent(c11, 'error');
    c11.emit('join', { roomId: VALID_ROOM_ID, role: 'parent', userName: 'Parent10' });
    const err = await errorPromise;
    expect(err.message).toContain('full');
  });

  it('allows mix of 5 babies and 10 parents', async () => {
    // Join 5 babies
    for (let i = 0; i < 5; i++) {
      const c = makeClient();
      await joinRoom(c, VALID_ROOM_ID, 'baby', `Baby${i}`);
    }

    // Join 10 parents — last one should show all 15
    let lastState;
    for (let i = 0; i < 10; i++) {
      const c = makeClient();
      lastState = await joinRoom(c, VALID_ROOM_ID, 'parent', `Parent${i}`);
    }

    expect(lastState.participants.length).toBe(15);
  }, 30000);
});
