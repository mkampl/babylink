/**
 * Multi-parent / multi-baby integration tests.
 * Tests realistic scenarios with multiple babies and parents in the same room.
 */
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

describe('Multi-baby, multi-parent scenarios', () => {
  it('2 babies + 2 parents: all see each other', async () => {
    const baby1 = makeClient();
    const baby2 = makeClient();
    const parent1 = makeClient();
    const parent2 = makeClient();

    await joinRoom(baby1, VALID_ROOM_ID, 'baby', 'Baby1');
    await joinRoom(baby2, VALID_ROOM_ID, 'baby', 'Baby2');
    await joinRoom(parent1, VALID_ROOM_ID, 'parent', 'Parent1');
    const state = await joinRoom(parent2, VALID_ROOM_ID, 'parent', 'Parent2');

    expect(state.participants.length).toBe(4);

    const babies = state.participants.filter(p => p.role === 'baby');
    const parents = state.participants.filter(p => p.role === 'parent');
    expect(babies.length).toBe(2);
    expect(parents.length).toBe(2);

    const names = state.participants.map(p => p.userName).sort();
    expect(names).toEqual(['Baby1', 'Baby2', 'Parent1', 'Parent2']);
  });

  it('baby joins, parent joins: baby receives participant-joined with parent info', async () => {
    const baby = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');

    const joinedPromise = waitForEvent(baby, 'participant-joined');
    const parent = makeClient();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const joined = await joinedPromise;
    expect(joined.role).toBe('parent');
    expect(joined.userName).toBe('Mom');
    expect(joined.participants.length).toBe(2);
  });

  it('parent joins, baby joins: parent receives participant-joined with baby info', async () => {
    const parent = makeClient();
    await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Dad');

    const joinedPromise = waitForEvent(parent, 'participant-joined');
    const baby = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Leo');

    const joined = await joinedPromise;
    expect(joined.role).toBe('baby');
    expect(joined.userName).toBe('Leo');
  });

  it('signal from baby reaches only targeted parent (unicast)', async () => {
    const baby = makeClient();
    const parent1 = makeClient();
    const parent2 = makeClient();

    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent1, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(parent2, VALID_ROOM_ID, 'parent', 'Dad');

    let parent2Received = false;
    parent2.on('signal', () => { parent2Received = true; });

    const p1Signal = waitForEvent(parent1, 'signal');
    baby.emit('signal', { offer: { type: 'offer', sdp: 'test' }, to: parent1.id });
    const sig = await p1Signal;

    expect(sig.offer).toBeDefined();
    expect(sig.fromUserName).toBe('Emma');

    await new Promise(r => setTimeout(r, 200));
    expect(parent2Received).toBe(false);
  });

  it('signal from baby broadcast reaches all parents', async () => {
    const baby = makeClient();
    const parent1 = makeClient();
    const parent2 = makeClient();

    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent1, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(parent2, VALID_ROOM_ID, 'parent', 'Dad');

    const p1Signal = waitForEvent(parent1, 'signal');
    const p2Signal = waitForEvent(parent2, 'signal');

    baby.emit('signal', { offer: { type: 'offer', sdp: 'broadcast' } });

    const [sig1, sig2] = await Promise.all([p1Signal, p2Signal]);
    expect(sig1.offer.sdp).toBe('broadcast');
    expect(sig2.offer.sdp).toBe('broadcast');
  });

  it('baby disconnect notifies all parents', async () => {
    const baby = makeClient();
    const parent1 = makeClient();
    const parent2 = makeClient();

    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    await joinRoom(parent1, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(parent2, VALID_ROOM_ID, 'parent', 'Dad');

    const babyId = baby.id;
    const p1Left = waitForEvent(parent1, 'participant-left');
    const p2Left = waitForEvent(parent2, 'participant-left');

    baby.disconnect();
    clients = clients.filter(c => c !== baby);

    const [left1, left2] = await Promise.all([p1Left, p2Left]);
    expect(left1.role).toBe('baby');
    expect(left1.socketId).toBe(babyId);
    expect(left2.role).toBe('baby');
    expect(left2.socketId).toBe(babyId);
  });

  it('parent disconnect notifies babies and other parents', async () => {
    const baby1 = makeClient();
    const baby2 = makeClient();
    const parent1 = makeClient();
    const parent2 = makeClient();

    await joinRoom(baby1, VALID_ROOM_ID, 'baby', 'Baby1');
    await joinRoom(baby2, VALID_ROOM_ID, 'baby', 'Baby2');
    await joinRoom(parent1, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(parent2, VALID_ROOM_ID, 'parent', 'Dad');

    const parentId = parent1.id;
    const b1Left = waitForEvent(baby1, 'participant-left');
    const b2Left = waitForEvent(baby2, 'participant-left');
    const p2Left = waitForEvent(parent2, 'participant-left');

    parent1.disconnect();
    clients = clients.filter(c => c !== parent1);

    const [l1, l2, l3] = await Promise.all([b1Left, b2Left, p2Left]);
    expect(l1.socketId).toBe(parentId);
    expect(l2.socketId).toBe(parentId);
    expect(l3.socketId).toBe(parentId);
    // 3 remaining
    expect(l1.participants.length).toBe(3);
  });

  it('3 babies + 1 parent: parent sees all babies in room-state', async () => {
    const b1 = makeClient();
    const b2 = makeClient();
    const b3 = makeClient();
    await joinRoom(b1, VALID_ROOM_ID, 'baby', 'Crib1');
    await joinRoom(b2, VALID_ROOM_ID, 'baby', 'Crib2');
    await joinRoom(b3, VALID_ROOM_ID, 'baby', 'Crib3');

    const parent = makeClient();
    const state = await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    const babies = state.participants.filter(p => p.role === 'baby');
    expect(babies.length).toBe(3);
    expect(babies.map(b => b.userName).sort()).toEqual(['Crib1', 'Crib2', 'Crib3']);
  });

  it('1 baby + 3 parents: baby sees all parents join', async () => {
    const baby = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');

    const joinedEvents = [];
    baby.on('participant-joined', (data) => {
      joinedEvents.push(data);
    });

    const p1 = makeClient();
    const p2 = makeClient();
    const p3 = makeClient();
    await joinRoom(p1, VALID_ROOM_ID, 'parent', 'Mom');
    await joinRoom(p2, VALID_ROOM_ID, 'parent', 'Dad');
    await joinRoom(p3, VALID_ROOM_ID, 'parent', 'Grandma');

    // Small wait for all events to arrive
    await new Promise(r => setTimeout(r, 200));

    expect(joinedEvents.length).toBe(3);
    const names = joinedEvents.map(e => e.userName).sort();
    expect(names).toEqual(['Dad', 'Grandma', 'Mom']);
  });

  it('participants have correct source field', async () => {
    const baby = makeClient();
    const parent = makeClient();
    await joinRoom(baby, VALID_ROOM_ID, 'baby', 'Emma');
    const state = await joinRoom(parent, VALID_ROOM_ID, 'parent', 'Mom');

    state.participants.forEach(p => {
      expect(p.source).toBe('socketio');
    });
  });

  it('each participant has a unique socketId', async () => {
    const c1 = makeClient();
    const c2 = makeClient();
    const c3 = makeClient();
    const c4 = makeClient();

    await joinRoom(c1, VALID_ROOM_ID, 'baby', 'B1');
    await joinRoom(c2, VALID_ROOM_ID, 'baby', 'B2');
    await joinRoom(c3, VALID_ROOM_ID, 'parent', 'P1');
    const state = await joinRoom(c4, VALID_ROOM_ID, 'parent', 'P2');

    const ids = state.participants.map(p => p.socketId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(4);
  });
});
