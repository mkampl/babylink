#!/usr/bin/env node
/*
 * ESP32 Baby Device Simulator
 *
 * Simulates an ESP32 baby device for development and testing
 * without requiring physical hardware.
 *
 * Usage:
 *   node tools/esp32-simulator.js
 *   node tools/esp32-simulator.js --room my-room --name "Simulated Baby"
 */

const WebSocket = require('ws');

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
  serverHost: process.env.SERVER_HOST || 'localhost',
  serverPort: process.env.SERVER_PORT || 3001,
  roomId: process.argv.includes('--room')
    ? process.argv[process.argv.indexOf('--room') + 1]
    : 'test-room',
  deviceName: process.argv.includes('--name')
    ? process.argv[process.argv.indexOf('--name') + 1]
    : 'ESP32 Simulator',
  sampleRate: 16000,
  channels: 1,
  bufferSize: 1024,
  audioInterval: 64, // ms (1024 samples / 16000 Hz * 1000)
};

// =============================================================================
// AUDIO SIMULATION
// =============================================================================

/**
 * Generate simulated PCM audio data
 * @param {string} level - 'quiet', 'movement', or 'crying'
 * @returns {Buffer} PCM audio buffer (16-bit signed integer)
 */
function generateAudioData(level) {
  const buffer = Buffer.alloc(config.bufferSize * 2); // 2 bytes per 16-bit sample

  for (let i = 0; i < config.bufferSize; i++) {
    let sample = 0;

    switch (level) {
      case 'quiet':
        // Low amplitude noise (0-50)
        sample = Math.floor(Math.random() * 50 - 25);
        break;

      case 'movement':
        // Medium amplitude noise with some tones (50-150)
        const frequency = 200 + Math.random() * 100;
        const time = i / config.sampleRate;
        sample = Math.floor(
          Math.sin(2 * Math.PI * frequency * time) * 100 +
          Math.random() * 50 - 25
        );
        break;

      case 'crying':
        // High amplitude noise with crying-like frequency (150-250)
        const cryFreq = 300 + Math.random() * 200;
        const cryTime = i / config.sampleRate;
        sample = Math.floor(
          Math.sin(2 * Math.PI * cryFreq * cryTime) * 200 +
          Math.random() * 100 - 50
        );
        break;
    }

    // Write 16-bit signed integer (little-endian)
    buffer.writeInt16LE(sample, i * 2);
  }

  return buffer;
}

// =============================================================================
// SIMULATOR STATE
// =============================================================================

class ESP32Simulator {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isRegistered = false;
    this.audioLevel = 'quiet';
    this.audioIntervalId = null;
    this.packetsSent = 0;
    this.startTime = null;
    this.deviceId = null;

    // Audio level cycle: quiet -> movement -> crying -> quiet
    this.levelCycle = ['quiet', 'quiet', 'quiet', 'movement', 'movement', 'crying', 'crying', 'quiet'];
    this.levelIndex = 0;
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    const url = `ws://${config.serverHost}:${config.serverPort}/esp32-baby`;
    console.log(`\n🔌 Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.handleOpen();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      this.handleClose(code, reason);
    });

    this.ws.on('error', (error) => {
      this.handleError(error);
    });
  }

  /**
   * Handle WebSocket open
   */
  handleOpen() {
    console.log('✅ WebSocket connected');
    this.isConnected = true;

    // Send registration message
    const registration = {
      type: 'register',
      roomId: config.roomId,
      name: config.deviceName,
      sampleRate: config.sampleRate,
      channels: config.channels
    };

    console.log('📤 Sending registration:', registration);
    this.ws.send(JSON.stringify(registration));
  }

  /**
   * Handle WebSocket message
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      console.log('📨 Received:', message);

      if (message.type === 'registered') {
        this.isRegistered = true;
        this.deviceId = message.id;
        this.startTime = Date.now();
        console.log(`✅ Registered as device: ${this.deviceId}`);
        console.log('🎤 Starting audio transmission...\n');

        // Start sending audio
        this.startAudioTransmission();
      } else if (message.type === 'pong') {
        console.log('💓 Heartbeat acknowledged');
      } else if (message.type === 'error') {
        console.error('❌ Server error:', message.message);
      }
    } catch (error) {
      // Probably binary data, ignore
    }
  }

  /**
   * Handle WebSocket close
   */
  handleClose(code, reason) {
    console.log(`\n❌ WebSocket closed: ${code} ${reason}`);
    this.isConnected = false;
    this.isRegistered = false;

    if (this.audioIntervalId) {
      clearInterval(this.audioIntervalId);
      this.audioIntervalId = null;
    }

    // Attempt reconnection after 5 seconds
    console.log('⏳ Reconnecting in 5 seconds...');
    setTimeout(() => {
      this.connect();
    }, 5000);
  }

  /**
   * Handle WebSocket error
   */
  handleError(error) {
    console.error('❌ WebSocket error:', error.message);
  }

  /**
   * Start audio transmission
   */
  startAudioTransmission() {
    let lastStatsTime = Date.now();

    this.audioIntervalId = setInterval(() => {
      if (!this.isConnected || !this.isRegistered) {
        return;
      }

      // Cycle through audio levels to simulate different scenarios
      if (this.packetsSent % 50 === 0) {
        this.levelIndex = (this.levelIndex + 1) % this.levelCycle.length;
        this.audioLevel = this.levelCycle[this.levelIndex];
      }

      // Generate and send audio data
      const audioData = generateAudioData(this.audioLevel);
      this.ws.send(audioData);
      this.packetsSent++;

      // Print statistics every 5 seconds
      const now = Date.now();
      if (now - lastStatsTime > 5000) {
        this.printStats();
        lastStatsTime = now;
      }
    }, config.audioInterval);
  }

  /**
   * Print statistics
   */
  printStats() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const packetsPerSecond = Math.floor(1000 / config.audioInterval);

    const levelEmoji = {
      quiet: '🟢',
      movement: '🟡',
      crying: '🔴'
    };

    console.log(`📊 Stats - ${levelEmoji[this.audioLevel]} Level: ${this.audioLevel.padEnd(8)} | Packets: ${this.packetsSent} | Uptime: ${uptime}s | Rate: ${packetsPerSecond}/s`);
  }

  /**
   * Send heartbeat
   */
  sendHeartbeat() {
    if (!this.isConnected || !this.isRegistered) {
      return;
    }

    const ping = { type: 'ping' };
    this.ws.send(JSON.stringify(ping));
  }

  /**
   * Start heartbeat interval
   */
  startHeartbeat() {
    setInterval(() => {
      this.sendHeartbeat();
    }, 30000); // Every 30 seconds
  }
}

// =============================================================================
// MAIN
// =============================================================================

function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   ESP32 Baby Device Simulator v1.0   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log();
  console.log('Configuration:');
  console.log(`  Server:      ${config.serverHost}:${config.serverPort}`);
  console.log(`  Room ID:     ${config.roomId}`);
  console.log(`  Device Name: ${config.deviceName}`);
  console.log(`  Sample Rate: ${config.sampleRate} Hz`);
  console.log(`  Buffer Size: ${config.bufferSize} samples`);
  console.log();

  const simulator = new ESP32Simulator();
  simulator.connect();
  simulator.startHeartbeat();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n⏹️  Shutting down simulator...');
    if (simulator.audioIntervalId) {
      clearInterval(simulator.audioIntervalId);
    }
    if (simulator.ws) {
      simulator.ws.close();
    }
    process.exit(0);
  });
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = ESP32Simulator;
