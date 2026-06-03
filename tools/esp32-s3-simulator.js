#!/usr/bin/env node
/*
 * XIAO ESP32-S3 simulator — register + ping only, no audio.
 *
 * Connects to /esp32-baby, sends a register frame with
 * device_type="esp32-s3", pings every 5 s.
 *
 * Usage:
 *   node tools/esp32-s3-simulator.js
 *   node tools/esp32-s3-simulator.js --room <room-id> --name "Sim S3"
 *   SERVER_HOST=your.server SERVER_PORT=443 node tools/esp32-s3-simulator.js --room <id>
 */

const WebSocket = require('ws');

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const config = {
  serverHost: process.env.SERVER_HOST || 'localhost',
  serverPort: parseInt(process.env.SERVER_PORT || '3001', 10),
  roomId: getArg('--room', 'test-room'),
  deviceName: getArg('--name', 'Simulated XIAO S3'),
  mac: getArg('--mac', 'aabbccddeeff'),
  sampleRate: 16000,
  channels: 1,
};

const proto = config.serverPort === 443 ? 'wss' : 'ws';
const url = `${proto}://${config.serverHost}:${config.serverPort}/esp32-baby`;

console.log('[s3-sim] connecting:', url);
const ws = new WebSocket(url);

let registered = false;
let heartbeatTimer = null;

ws.on('open', () => {
  console.log('[s3-sim] open, sending register');
  ws.send(JSON.stringify({
    type: 'register',
    roomId: config.roomId,
    name: config.deviceName,
    mac: config.mac,
    sampleRate: config.sampleRate,
    channels: config.channels,
    device_type: 'esp32-s3',
  }));
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === 'registered') {
    registered = true;
    console.log(`[s3-sim] registered id=${msg.id}`);
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 5000);
  } else if (msg.type === 'pong') {
    process.stdout.write('.');
  } else if (msg.type === 'factory-reset') {
    console.log('\n[s3-sim] factory-reset received from server');
  } else if (msg.type === 'error') {
    console.error('[s3-sim] server error:', msg.message);
  }
});

ws.on('close', (code, reason) => {
  console.log(`\n[s3-sim] closed code=${code} reason=${reason}`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});

ws.on('error', (err) => {
  console.error('[s3-sim] ws error:', err.message);
});

process.on('SIGINT', () => {
  console.log('\n[s3-sim] shutting down');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  ws.close();
  setTimeout(() => process.exit(0), 100);
});
