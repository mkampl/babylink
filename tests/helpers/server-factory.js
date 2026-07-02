// Test helper: creates isolated server instances

const request = require('supertest');
const { createServer } = require('../../server');

/**
 * Start a fresh server instance on a random port.
 * Returns { app, server, io, rooms, esp32Proxy, port, baseUrl, close }
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const instance = createServer();
    const { app, server, io, rooms, esp32Proxy, intervals } = instance;

    server.listen(0, () => {
      const port = server.address().port;
      const baseUrl = `http://localhost:${port}`;

      const close = () => {
        return new Promise((res) => {
          // Clear all intervals
          intervals.forEach(id => clearInterval(id));

          // Close ESP32 WSS
          if (esp32Proxy.wss) {
            esp32Proxy.wss.close();
          }

          // Disconnect all Socket.IO clients
          io.disconnectSockets(true);

          // Close the HTTP server
          server.close(() => res());
        });
      };

      resolve({ app, server, io, rooms, esp32Proxy, port, baseUrl, close });
    });

    server.on('error', reject);
  });
}

/**
 * Create a room via POST /api/rooms and return { roomId, ownerToken }.
 * Throws if the server does not respond with 201.
 *
 * @param {object} app - Express app (from startServer().app)
 * @param {object} [body] - Optional request body (e.g. { name: 'Nursery' })
 */
async function createRoom(app, body = {}) {
  const res = await request(app).post('/api/rooms').send(body);
  if (res.status !== 201) {
    throw new Error(`createRoom failed: HTTP ${res.status} – ${JSON.stringify(res.body)}`);
  }
  return { roomId: res.body.roomId, ownerToken: res.body.ownerToken };
}

module.exports = { startServer, createRoom };
