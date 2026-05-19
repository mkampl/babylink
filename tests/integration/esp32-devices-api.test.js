const request = require('supertest');
const { startServer } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');

const DEVICE_ROOM = 'ab'.repeat(16);
const DEVICE_ROOM_2 = 'ac'.repeat(16);

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('ESP32 Device Management API', () => {
  describe('GET /api/rooms/:roomId/esp32/devices', () => {
    it('returns empty array when no devices connected', async () => {
      const res = await request(server.app)
        .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
      expect(res.status).toBe(200);
      expect(res.body.devices).toEqual([]);
    });

    it('rejects invalid room ID', async () => {
      const res = await request(server.app)
        .get('/api/rooms/invalid/esp32/devices');
      expect(res.status).toBe(400);
    });

    it('returns device after ESP32 registers', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(DEVICE_ROOM, 'TestDevice1');

        const res = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        expect(res.status).toBe(200);
        expect(res.body.devices.length).toBe(1);
        expect(res.body.devices[0].name).toBe('TestDevice1');
        expect(res.body.devices[0].id).toMatch(/^esp32_/);
        expect(res.body.devices[0]).toHaveProperty('clientIp');
        expect(res.body.devices[0]).toHaveProperty('uptime');
      } finally {
        await esp32.close();
      }
    });

    it('filters by room — device in room A not shown for room B', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(DEVICE_ROOM_2, 'RoomBDevice');

        const resA = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const deviceNamesA = resA.body.devices.map(d => d.name);
        expect(deviceNamesA).not.toContain('RoomBDevice');

        const resB = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM_2}/esp32/devices`);
        const deviceNamesB = resB.body.devices.map(d => d.name);
        expect(deviceNamesB).toContain('RoomBDevice');
      } finally {
        await esp32.close();
      }
    });
  });

  describe('PATCH /api/rooms/:roomId/esp32/:esp32Id', () => {
    it('renames a device', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        const regResult = await esp32.register(DEVICE_ROOM, 'OriginalName');

        // Get the device ID from the list
        const listRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const device = listRes.body.devices.find(d => d.name === 'OriginalName');
        expect(device).toBeDefined();

        // Rename
        const res = await request(server.app)
          .patch(`/api/rooms/${DEVICE_ROOM}/esp32/${device.id}`)
          .send({ name: 'NewName' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.device.name).toBe('NewName');

        // Verify in list
        const verifyRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const renamed = verifyRes.body.devices.find(d => d.id === device.id);
        expect(renamed.name).toBe('NewName');
      } finally {
        await esp32.close();
      }
    });

    it('returns 404 for non-existent device', async () => {
      const res = await request(server.app)
        .patch(`/api/rooms/${DEVICE_ROOM}/esp32/esp32_nonexistent`)
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
    });

    it('returns 400 for missing name', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(DEVICE_ROOM, 'SomeDevice');
        const listRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const device = listRes.body.devices.find(d => d.name === 'SomeDevice');

        const res = await request(server.app)
          .patch(`/api/rooms/${DEVICE_ROOM}/esp32/${device.id}`)
          .send({});
        expect(res.status).toBe(400);
      } finally {
        await esp32.close();
      }
    });
  });

  describe('DELETE /api/rooms/:roomId/esp32/:esp32Id', () => {
    it('disconnects a device', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(DEVICE_ROOM, 'ToDisconnect');

        const listRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const device = listRes.body.devices.find(d => d.name === 'ToDisconnect');
        expect(device).toBeDefined();

        const res = await request(server.app)
          .delete(`/api/rooms/${DEVICE_ROOM}/esp32/${device.id}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify device is gone
        const verifyRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const found = verifyRes.body.devices.find(d => d.id === device.id);
        expect(found).toBeUndefined();
      } finally {
        await esp32.close();
      }
    });

    it('returns 404 for non-existent device', async () => {
      const res = await request(server.app)
        .delete(`/api/rooms/${DEVICE_ROOM}/esp32/esp32_nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('MAC-keyed stable IDs', () => {
    it('uses esp32_<mac> as the device ID when MAC is provided', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        const reg = await esp32.register(DEVICE_ROOM, 'MacDevice', 'AA:BB:CC:DD:EE:01');
        expect(reg.id).toBe('esp32_aabbccddee01');
      } finally {
        await esp32.close();
      }
    });

    it('reuses the same ID across reconnects with the same MAC', async () => {
      const MAC = 'AA:BB:CC:DD:EE:02';
      const first = createESP32Client(server.port);
      let firstId;
      try {
        const reg = await first.register(DEVICE_ROOM, 'MacReconnect', MAC);
        firstId = reg.id;
      } finally {
        await first.close();
      }

      // Brief pause to ensure close has propagated
      await new Promise(r => setTimeout(r, 100));

      const second = createESP32Client(server.port);
      try {
        const reg = await second.register(DEVICE_ROOM, 'MacReconnect', MAC);
        expect(reg.id).toBe(firstId);

        // Only one entry exists for this MAC
        const list = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const matches = list.body.devices.filter(d => d.id === firstId);
        expect(matches.length).toBe(1);
      } finally {
        await second.close();
      }
    });

    it('preserves a user-applied rename across a same-MAC reconnect', async () => {
      const MAC = 'AA:BB:CC:DD:EE:03';
      const first = createESP32Client(server.port);
      let id;
      try {
        const reg = await first.register(DEVICE_ROOM, 'Initial', MAC);
        id = reg.id;

        const renameRes = await request(server.app)
          .patch(`/api/rooms/${DEVICE_ROOM}/esp32/${id}`)
          .send({ name: 'Nursery' });
        expect(renameRes.status).toBe(200);
      } finally {
        await first.close();
      }

      await new Promise(r => setTimeout(r, 100));

      const second = createESP32Client(server.port);
      try {
        // Firmware re-registers with its hardcoded default — server should keep the rename
        await second.register(DEVICE_ROOM, 'Initial', MAC);
        const list = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const dev = list.body.devices.find(d => d.id === id);
        expect(dev).toBeDefined();
        expect(dev.name).toBe('Nursery');
      } finally {
        await second.close();
      }
    });

    it('still works for legacy clients that do not send a MAC', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        const reg = await esp32.register(DEVICE_ROOM, 'LegacyDevice');
        expect(reg.id).toMatch(/^esp32_\d+_[a-z0-9]+$/);
      } finally {
        await esp32.close();
      }
    });
  });

  describe('POST /api/rooms/:roomId/esp32/:esp32Id/reset', () => {
    it('sends factory-reset to a connected device and removes it from the list', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(DEVICE_ROOM, 'ToReset');

        // Capture the JSON message the firmware would receive
        const resetMsgPromise = esp32.waitForMessage('factory-reset', 2000);

        const listRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        const device = listRes.body.devices.find(d => d.name === 'ToReset');
        expect(device).toBeDefined();

        const res = await request(server.app)
          .post(`/api/rooms/${DEVICE_ROOM}/esp32/${device.id}/reset`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const resetMsg = await resetMsgPromise;
        expect(resetMsg.type).toBe('factory-reset');

        await new Promise(resolve => setTimeout(resolve, 200));
        const verifyRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM}/esp32/devices`);
        expect(verifyRes.body.devices.find(d => d.id === device.id)).toBeUndefined();
      } finally {
        await esp32.close();
      }
    });

    it('returns 404 for non-existent device', async () => {
      const res = await request(server.app)
        .post(`/api/rooms/${DEVICE_ROOM}/esp32/esp32_nonexistent/reset`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when device is in a different room', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(DEVICE_ROOM_2, 'OtherRoomDevice');
        const listRes = await request(server.app)
          .get(`/api/rooms/${DEVICE_ROOM_2}/esp32/devices`);
        const device = listRes.body.devices.find(d => d.name === 'OtherRoomDevice');

        // Try resetting via the wrong room — must 404
        const res = await request(server.app)
          .post(`/api/rooms/${DEVICE_ROOM}/esp32/${device.id}/reset`);
        expect(res.status).toBe(404);
      } finally {
        await esp32.close();
      }
    });
  });
});
