// Test helper: creates isolated server instances

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

module.exports = { startServer };
