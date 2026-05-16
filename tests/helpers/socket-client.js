// Test helper: Socket.IO client factory

const { io } = require('socket.io-client');

/**
 * Create a Socket.IO client connected to the test server.
 */
function createSocketClient(port, options = {}) {
  const client = io(`http://localhost:${port}`, {
    autoConnect: true,
    transports: ['websocket'],
    forceNew: true,
    ...options,
  });
  return client;
}

/**
 * Wait for a specific event on a socket client.
 */
function waitForEvent(client, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    client.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Connect a socket client and join a room.
 * Returns the room-state data.
 */
async function joinRoom(client, roomId, role, userName) {
  // Wait for connection if not connected
  if (!client.connected) {
    await waitForEvent(client, 'connect');
  }

  const roomStatePromise = waitForEvent(client, 'room-state');
  client.emit('join', { roomId, role, userName });
  return roomStatePromise;
}

/**
 * Disconnect a socket client and wait for it to fully disconnect.
 */
function disconnectClient(client) {
  return new Promise((resolve) => {
    if (!client.connected) {
      resolve();
      return;
    }
    client.once('disconnect', () => resolve());
    client.disconnect();
  });
}

module.exports = { createSocketClient, waitForEvent, joinRoom, disconnectClient };
