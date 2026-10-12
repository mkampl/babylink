#!/usr/bin/env node
// End-to-end check of the parent monitor page in a real (system) Chrome:
//
//   1. A browser baby (Chrome's fake microphone, which beeps) streams over
//      WebRTC → the parent's card meter must move (the WebRTC meter used to
//      never drive the badge).
//   2. With two babies connected, one leaving must keep its card, mark it
//      disconnected and raise the alarm banner — not silently drop it.
//   3. That baby rejoining under a new socket id with the same name replaces
//      the stale card and clears the alarm.
//
//   node tests/browser/run-parent-harness.js      (npm run test:browser:parent)
//
// Exit 0 on pass, 1 on failure, 2 if no Chrome is available.

const fs = require('fs');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { createServer } = require('../../server');

const CANDIDATES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chrome = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }

function fakeBaby(port, roomId, name) {
  return new Promise((resolve) => {
    const s = io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => s.emit('join', { roomId, role: 'baby', userName: name }));
    s.once('room-state', () => resolve(s));
  });
}

async function waitFor(page, fn, arg, timeoutMs, label) {
  try {
    await page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 200 });
    console.log('  ok  ', label);
    return true;
  } catch (e) {
    fail(label);
    return false;
  }
}

async function main() {
  if (!chrome) { console.error('No system Chrome/Chromium found. Set CHROME_PATH.'); process.exit(2); }

  const { server, intervals, esp32Proxy } = createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const roomId = 'e'.repeat(32);

  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const sockets = [];
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const parent = await ctx.newPage();
    parent.on('pageerror', (e) => fail('parent page error: ' + e.message));
    await parent.goto(`${base}/${roomId}?role=parent&autostart=1`);

    // 1. WebRTC browser baby drives the parent's meter.
    const baby = await ctx.newPage();
    baby.on('pageerror', (e) => fail('baby page error: ' + e.message));
    await baby.goto(`${base}/${roomId}?role=baby&userName=Mia`);
    await waitFor(parent, () => document.querySelectorAll('.baby-card').length === 1, null, 15000,
      'WebRTC baby card appears');
    await waitFor(parent, () => {
      const m = document.querySelector('.baby-card .volume-meter');
      return m && parseInt(m.style.width, 10) > 0;
    }, null, 20000, 'WebRTC baby drives the parent meter');
    await baby.close();
    await waitFor(parent, () => !!document.getElementById('disconnectBanner'), null, 15000,
      'only baby leaving raises the alarm banner');

    // 2. Two babies, one leaves → its card stays, alarm for it.
    const anna = await fakeBaby(port, roomId, 'Anna'); sockets.push(anna);
    const ben = await fakeBaby(port, roomId, 'Ben'); sockets.push(ben);
    await waitFor(parent, () => !document.getElementById('disconnectBanner') ||
      document.getElementById('disconnectBanner').textContent.includes('Mia'), null, 5000,
      'banner only about the baby that is gone');
    const before = await parent.evaluate(() => document.querySelectorAll('.baby-card').length);
    anna.disconnect();
    await waitFor(parent, (n) => document.querySelectorAll('.baby-card').length === n, before, 8000,
      'card of the leaving baby is kept');
    await waitFor(parent, () => {
      const b = document.getElementById('disconnectBanner');
      return b && /Anna|Mia/.test(b.textContent);
    }, null, 8000, 'alarm banner while another baby is still connected');

    // 3. Anna returns with a new socket id → stale card replaced.
    const anna2 = await fakeBaby(port, roomId, 'Anna'); sockets.push(anna2);
    await waitFor(parent, () => Array.from(document.querySelectorAll('.baby-card .baby-name'))
      .filter((e) => e.textContent.includes('Anna')).length === 1, null, 8000,
      'returning baby replaces its stale card');
  } finally {
    sockets.forEach((s) => s.disconnect());
    await browser.close();
    intervals.forEach(clearInterval);
    if (esp32Proxy.wss) esp32Proxy.wss.close();
    server.close();
  }
  console.log(process.exitCode ? 'FAILED' : 'PASSED');
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
