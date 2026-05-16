// Test helper: ESP32 WebSocket client simulator

const WebSocket = require('ws');

/**
 * Create a WebSocket client simulating an ESP32 device.
 */
function createESP32Client(port) {
  const ws = new WebSocket(`ws://localhost:${port}/esp32-baby`);

  const helpers = {
    ws,

    /** Wait for the WebSocket to open */
    waitForOpen() {
      return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) {
          resolve();
          return;
        }
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    },

    /** Send a register message and wait for response */
    async register(roomId, name = 'Test ESP32') {
      await helpers.waitForOpen();
      const responsePromise = helpers.waitForMessage('registered');
      ws.send(JSON.stringify({ type: 'register', roomId, name }));
      return responsePromise;
    },

    /** Send binary audio data */
    sendAudio(buffer) {
      if (!buffer) {
        // Generate a small fake audio buffer (16-bit PCM, 160 samples = 10ms at 16kHz)
        buffer = Buffer.alloc(320);
        for (let i = 0; i < 160; i++) {
          buffer.writeInt16LE(Math.floor(Math.random() * 1000), i * 2);
        }
      }
      ws.send(buffer);
    },

    /** Send a ping and wait for pong */
    async sendPing() {
      const pongPromise = helpers.waitForMessage('pong');
      ws.send(JSON.stringify({ type: 'ping' }));
      return pongPromise;
    },

    /** Wait for a specific message type */
    waitForMessage(type, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for message type '${type}' after ${timeoutMs}ms`));
        }, timeoutMs);

        const handler = (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === type) {
              clearTimeout(timer);
              ws.removeListener('message', handler);
              resolve(message);
            }
          } catch (e) {
            // Not JSON, ignore (binary audio data)
          }
        };

        ws.on('message', handler);
      });
    },

    /** Close the connection */
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          resolve();
          return;
        }
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };

  return helpers;
}

module.exports = { createESP32Client };
