#!/usr/bin/env node
/**
 * Live E2E test against a running BabyLink server.
 * Tests the full baby-parent connection flow with simulated audio.
 *
 * Usage: node tests/manual/e2e-live-test.js [serverUrl]
 */

const { io } = require('socket.io-client');
const http = require('http');

const SERVER = process.argv[2] || 'http://localhost:3001';
const ROOM_ID = 'a'.repeat(32); // Valid 32-char hex

// Helpers
function log(prefix, msg) {
  console.log(`[${prefix}] ${msg}`);
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function waitForEvent(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function assert(name, condition, detail) {
    if (condition) {
      log('PASS', name);
      passed++;
    } else {
      log('FAIL', `${name} — ${detail || 'assertion failed'}`);
      failed++;
      failures.push(name);
    }
  }

  // ========== Phase 1: HTTP Endpoints ==========
  log('TEST', '=== Phase 1: HTTP Endpoints ===');

  let initialRooms = 0;
  try {
    const health = await get(`${SERVER}/health`);
    const healthBody = JSON.parse(health.body);
    assert('Health endpoint returns 200', health.status === 200);
    assert('Health status is healthy', healthBody.status === 'healthy');
    // Note: rooms may not be 0 if browser tabs or healthcheck are connected
    initialRooms = healthBody.rooms;
    log('INFO', `Initial rooms: ${initialRooms} (browser tabs may be connected)`);
  } catch (e) {
    assert('Server reachable', false, e.message);
    console.error('Server not reachable, aborting.');
    process.exit(1);
  }

  const homePage = await get(`${SERVER}/`);
  assert('Home page loads', homePage.status === 200);
  assert('Home page contains BabyLink', homePage.body.includes('BabyLink'));

  const rolePage = await get(`${SERVER}/${ROOM_ID}`);
  assert('Role selection page loads', rolePage.status === 200);

  const monitorPage = await get(`${SERVER}/${ROOM_ID}?role=parent`);
  assert('Monitor page loads for parent', monitorPage.status === 200);
  assert('Monitor page contains initialize()', monitorPage.body.includes('initialize()'));
  assert('Monitor page does NOT use DOMContentLoaded for init',
    !monitorPage.body.includes("addEventListener('DOMContentLoaded', initialize)"));

  const babyPage = await get(`${SERVER}/${ROOM_ID}?role=baby`);
  assert('Monitor page loads for baby', babyPage.status === 200);

  // Check CSS files load
  const cssVars = await get(`${SERVER}/css/variables.css`);
  assert('CSS variables.css loads', cssVars.status === 200);
  assert('CSS has dark mode', cssVars.body.includes('prefers-color-scheme: dark'));

  const cssBase = await get(`${SERVER}/css/base.css`);
  assert('CSS base.css loads', cssBase.status === 200);
  assert('Theme toggle CSS present', cssBase.body.includes('.theme-toggle'));

  const utils = await get(`${SERVER}/js/utils.js`);
  assert('utils.js loads', utils.status === 200);
  assert('utils.js has ThemeManager', utils.body.includes('ThemeManager'));
  assert('utils.js has escapeHtml', utils.body.includes('escapeHtml'));

  // ========== Phase 2: Socket.IO — Baby joins first ==========
  log('TEST', '=== Phase 2: Socket.IO Baby-Parent Flow ===');

  const baby = io(SERVER, { transports: ['websocket'], forceNew: true });
  await waitForEvent(baby, 'connect');
  log('INFO', `Baby connected: ${baby.id}`);

  // Baby joins room
  const babyRoomStatePromise = waitForEvent(baby, 'room-state');
  baby.emit('join', { roomId: ROOM_ID, role: 'baby', userName: 'TestBaby' });
  const babyRoomState = await babyRoomStatePromise;

  assert('Baby receives room-state', !!babyRoomState);
  assert('Baby sees itself in participants',
    babyRoomState.participants.some(p => p.role === 'baby' && p.userName === 'TestBaby'),
    `participants: ${JSON.stringify(babyRoomState.participants)}`);
  assert('Room has 1 participant initially',
    babyRoomState.participants.length === 1,
    `got ${babyRoomState.participants.length}`);

  // Check health shows room count increased
  const healthAfterBaby = JSON.parse((await get(`${SERVER}/health`)).body);
  assert('Health shows more rooms after baby joins',
    healthAfterBaby.rooms >= initialRooms + 1,
    `expected >= ${initialRooms + 1}, got ${healthAfterBaby.rooms}`);

  // ========== Phase 3: Parent joins ==========
  log('TEST', '=== Phase 3: Parent Joins ===');

  // Listen for participant-joined on baby side BEFORE parent joins
  const babySeesParentPromise = waitForEvent(baby, 'participant-joined');

  const parent = io(SERVER, { transports: ['websocket'], forceNew: true });
  await waitForEvent(parent, 'connect');
  log('INFO', `Parent connected: ${parent.id}`);

  const parentRoomStatePromise = waitForEvent(parent, 'room-state');
  parent.emit('join', { roomId: ROOM_ID, role: 'parent', userName: 'TestParent' });
  const parentRoomState = await parentRoomStatePromise;

  assert('Parent receives room-state', !!parentRoomState);
  assert('Parent sees 2 participants',
    parentRoomState.participants.length === 2,
    `got ${parentRoomState.participants.length}: ${JSON.stringify(parentRoomState.participants)}`);
  assert('Parent sees baby in room',
    parentRoomState.participants.some(p => p.role === 'baby' && p.userName === 'TestBaby'));
  assert('Parent sees itself in room',
    parentRoomState.participants.some(p => p.role === 'parent' && p.userName === 'TestParent'));

  // Check baby received participant-joined
  const babySeesParent = await babySeesParentPromise;
  assert('Baby receives participant-joined for parent', !!babySeesParent);
  assert('Baby sees parent role in event', babySeesParent.role === 'parent',
    `got role: ${babySeesParent.role}`);
  assert('Baby sees parent name in event', babySeesParent.userName === 'TestParent',
    `got userName: ${babySeesParent.userName}`);
  assert('Baby event has updated participants list',
    babySeesParent.participants.length === 2,
    `got ${babySeesParent.participants.length}`);

  // ========== Phase 4: WebRTC Signaling ==========
  log('TEST', '=== Phase 4: WebRTC Signaling ===');

  // Baby sends offer to parent
  const parentSignalPromise = waitForEvent(parent, 'signal');
  baby.emit('signal', {
    offer: { type: 'offer', sdp: 'v=0\r\nfake-sdp-baby-offer' },
    to: parent.id
  });
  const parentSignal = await parentSignalPromise;
  assert('Parent receives offer from baby', !!parentSignal.offer);
  assert('Signal has from=baby', parentSignal.from === 'baby');
  assert('Signal has fromSocketId', parentSignal.fromSocketId === baby.id);
  assert('Signal has fromUserName=TestBaby', parentSignal.fromUserName === 'TestBaby');

  // Parent sends answer back
  const babySignalPromise = waitForEvent(baby, 'signal');
  parent.emit('signal', {
    answer: { type: 'answer', sdp: 'v=0\r\nfake-sdp-parent-answer' },
    to: baby.id
  });
  const babySignal = await babySignalPromise;
  assert('Baby receives answer from parent', !!babySignal.answer);
  assert('Answer signal has from=parent', babySignal.from === 'parent');

  // ICE candidate exchange
  const parentIcePromise = waitForEvent(parent, 'signal');
  baby.emit('signal', { ice: { candidate: 'fake-ice-candidate' }, to: parent.id });
  const parentIce = await parentIcePromise;
  assert('Parent receives ICE candidate from baby', !!parentIce.ice);

  // ========== Phase 5: Second parent joins ==========
  log('TEST', '=== Phase 5: Second Parent ===');

  const babySeesParent2Promise = waitForEvent(baby, 'participant-joined');
  const parent1SeesParent2Promise = waitForEvent(parent, 'participant-joined');

  const parent2 = io(SERVER, { transports: ['websocket'], forceNew: true });
  await waitForEvent(parent2, 'connect');
  log('INFO', `Parent2 connected: ${parent2.id}`);

  const parent2RoomState = await new Promise((resolve) => {
    parent2.once('room-state', resolve);
    parent2.emit('join', { roomId: ROOM_ID, role: 'parent', userName: 'TestParent2' });
  });

  assert('Parent2 sees 3 participants', parent2RoomState.participants.length === 3,
    `got ${parent2RoomState.participants.length}`);

  const babySeesParent2 = await babySeesParent2Promise;
  assert('Baby sees second parent join', babySeesParent2.userName === 'TestParent2');

  const parent1SeesParent2 = await parent1SeesParent2Promise;
  assert('Parent1 sees second parent join', parent1SeesParent2.userName === 'TestParent2');

  // ========== Phase 6: Disconnect ==========
  log('TEST', '=== Phase 6: Disconnect Flow ===');

  const babySeesParent2Leave = waitForEvent(baby, 'participant-left');
  const parent1SeesParent2Leave = waitForEvent(parent, 'participant-left');

  parent2.disconnect();

  const leftEventBaby = await babySeesParent2Leave;
  assert('Baby sees parent2 leave', leftEventBaby.role === 'parent');
  assert('Baby sees 2 remaining participants', leftEventBaby.participants.length === 2,
    `got ${leftEventBaby.participants.length}`);

  const leftEventParent1 = await parent1SeesParent2Leave;
  assert('Parent1 sees parent2 leave', leftEventParent1.role === 'parent');

  // ========== Phase 7: Baby disconnect ==========
  log('TEST', '=== Phase 7: Baby Disconnect ===');

  const parentSeesBabyLeave = waitForEvent(parent, 'participant-left');
  baby.disconnect();

  const babyLeftEvent = await parentSeesBabyLeave;
  assert('Parent sees baby leave', babyLeftEvent.role === 'baby');
  assert('Parent sees 1 remaining (itself)', babyLeftEvent.participants.length === 1);

  // Last participant leaves
  parent.disconnect();
  await sleep(500);

  const finalHealth = JSON.parse((await get(`${SERVER}/health`)).body);
  assert('Test room cleaned up after all leave',
    finalHealth.rooms <= initialRooms,
    `expected <= ${initialRooms}, got ${finalHealth.rooms}`);

  // ========== Phase 8: Verify served HTML ==========
  log('TEST', '=== Phase 8: HTML Content Verification ===');

  const webrtcHtml = (await get(`${SERVER}/${ROOM_ID}?role=baby`)).body;

  assert('webrtc.html calls initialize() at script end',
    webrtcHtml.includes('initialize()') && !webrtcHtml.includes("DOMContentLoaded', initialize"),
    'Still using DOMContentLoaded listener instead of direct call');

  assert('webrtc.html loads external CSS',
    webrtcHtml.includes('css/variables.css') && webrtcHtml.includes('css/components.css'));

  assert('webrtc.html loads utils.js', webrtcHtml.includes('js/utils.js'));

  assert('webrtc.html has no inline <style> block',
    !webrtcHtml.match(/<style>[\s\S]{100,}<\/style>/),
    'Found large inline style block');

  assert('webrtc.html creates ThemeManager toggle',
    webrtcHtml.includes('ThemeManager.createToggleButton'));

  // Home page check
  const homeHtml = (await get(`${SERVER}/`)).body;
  assert('Home page has body.home-page class', homeHtml.includes('class="home-page"'));
  assert('Home page loads utils.js', homeHtml.includes('js/utils.js'));

  // ========== Summary ==========
  console.log('\n' + '='.repeat(50));
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
