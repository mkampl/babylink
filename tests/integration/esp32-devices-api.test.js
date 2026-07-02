const request = require('supertest');
const { startServer, createRoom } = require('../helpers/server-factory');
const { createESP32Client } = require('../helpers/esp32-client');

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('ESP32 Device Management API', () => {
  describe('GET /api/rooms/:roomId/esp32/devices (owner-authenticated)', () => {
    it('returns 401 without owner token', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app).get(`/api/rooms/${roomId}/esp32/devices`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for lazy-created room (no owner)', async () => {
      const lazyRoomId = 'ab'.repeat(16);
      const res = await request(server.app)
        .get(`/api/rooms/${lazyRoomId}/esp32/devices`)
        .set('Authorization', 'Bearer some-token');
      expect(res.status).toBe(403);
    });

    it('returns empty array when no devices connected', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .get(`/api/rooms/${roomId}/esp32/devices`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.devices).toEqual([]);
    });

    it('rejects invalid room ID', async () => {
      const res = await request(server.app)
        .get('/api/rooms/invalid/esp32/devices')
        .set('Authorization', 'Bearer anything');
      expect(res.status).toBe(400);
    });

    it('returns device after ESP32 registers', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomId, 'TestDevice1');

        const res = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
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
      const roomA = await createRoom(server.app);
      const roomB = await createRoom(server.app);

      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomB.roomId, 'RoomBDevice');

        const resA = await request(server.app)
          .get(`/api/rooms/${roomA.roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${roomA.ownerToken}`);
        const deviceNamesA = resA.body.devices.map(d => d.name);
        expect(deviceNamesA).not.toContain('RoomBDevice');

        const resB = await request(server.app)
          .get(`/api/rooms/${roomB.roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${roomB.ownerToken}`);
        const deviceNamesB = resB.body.devices.map(d => d.name);
        expect(deviceNamesB).toContain('RoomBDevice');
      } finally {
        await esp32.close();
      }
    });
  });

  describe('PATCH /api/rooms/:roomId/esp32/:esp32Id (owner-authenticated)', () => {
    it('returns 401 without owner token', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app)
        .patch(`/api/rooms/${roomId}/esp32/esp32_aabbccdd0001`)
        .send({ name: 'Test' });
      expect(res.status).toBe(401);
    });

    it('renames a device', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomId, 'OriginalName');

        const listRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const device = listRes.body.devices.find(d => d.name === 'OriginalName');
        expect(device).toBeDefined();

        const res = await request(server.app)
          .patch(`/api/rooms/${roomId}/esp32/${device.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ name: 'NewName' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.device.name).toBe('NewName');

        const verifyRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const renamed = verifyRes.body.devices.find(d => d.id === device.id);
        expect(renamed.name).toBe('NewName');
      } finally {
        await esp32.close();
      }
    });

    it('returns 404 for non-existent device', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .patch(`/api/rooms/${roomId}/esp32/esp32_nonexistent`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
    });

    it('returns 400 for missing name', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomId, 'SomeDevice');
        const listRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const device = listRes.body.devices.find(d => d.name === 'SomeDevice');

        const res = await request(server.app)
          .patch(`/api/rooms/${roomId}/esp32/${device.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({});
        expect(res.status).toBe(400);
      } finally {
        await esp32.close();
      }
    });
  });

  describe('DELETE /api/rooms/:roomId/esp32/:esp32Id (owner-authenticated)', () => {
    it('returns 401 without owner token', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app)
        .delete(`/api/rooms/${roomId}/esp32/esp32_any`);
      expect(res.status).toBe(401);
    });

    it('disconnects a device', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomId, 'ToDisconnect');

        const listRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const device = listRes.body.devices.find(d => d.name === 'ToDisconnect');
        expect(device).toBeDefined();

        const res = await request(server.app)
          .delete(`/api/rooms/${roomId}/esp32/${device.id}`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        await new Promise(resolve => setTimeout(resolve, 200));

        const verifyRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const found = verifyRes.body.devices.find(d => d.id === device.id);
        expect(found).toBeUndefined();
      } finally {
        await esp32.close();
      }
    });

    it('returns 404 for non-existent device', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .delete(`/api/rooms/${roomId}/esp32/esp32_nonexistent`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('MAC-keyed stable IDs', () => {
    it('uses esp32_<mac> as the device ID when MAC is provided', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        const reg = await esp32.register(roomId, 'MacDevice', 'AA:BB:CC:DD:EE:01');
        expect(reg.id).toBe('esp32_aabbccddee01');
      } finally {
        await esp32.close();
      }
    });

    it('reuses the same ID across reconnects with the same MAC', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const MAC = 'AA:BB:CC:DD:EE:02';
      const first = createESP32Client(server.port);
      let firstId;
      try {
        const reg = await first.register(roomId, 'MacReconnect', MAC);
        firstId = reg.id;
      } finally {
        await first.close();
      }

      await new Promise(r => setTimeout(r, 100));

      const second = createESP32Client(server.port);
      try {
        const reg = await second.register(roomId, 'MacReconnect', MAC);
        expect(reg.id).toBe(firstId);

        const list = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const matches = list.body.devices.filter(d => d.id === firstId);
        expect(matches.length).toBe(1);
      } finally {
        await second.close();
      }
    });

    it('preserves a user-applied rename across a same-MAC reconnect', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const MAC = 'AA:BB:CC:DD:EE:03';
      const first = createESP32Client(server.port);
      let id;
      try {
        const reg = await first.register(roomId, 'Initial', MAC);
        id = reg.id;

        const renameRes = await request(server.app)
          .patch(`/api/rooms/${roomId}/esp32/${id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ name: 'Nursery' });
        expect(renameRes.status).toBe(200);
      } finally {
        await first.close();
      }

      await new Promise(r => setTimeout(r, 100));

      const second = createESP32Client(server.port);
      try {
        await second.register(roomId, 'Initial', MAC);
        const list = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const dev = list.body.devices.find(d => d.id === id);
        expect(dev).toBeDefined();
        expect(dev.name).toBe('Nursery');
      } finally {
        await second.close();
      }
    });

    it('still works for clients that do not send a MAC', async () => {
      const esp32 = createESP32Client(server.port);
      try {
        const { roomId } = await createRoom(server.app);
        const reg = await esp32.register(roomId, 'LegacyDevice');
        expect(reg.id).toMatch(/^esp32_\d+_[a-z0-9]+$/);
      } finally {
        await esp32.close();
      }
    });
  });

  describe('POST /api/rooms/:roomId/esp32/:esp32Id/reset (owner-authenticated)', () => {
    it('returns 401 without owner token', async () => {
      const { roomId } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/esp32/esp32_any/reset`);
      expect(res.status).toBe(401);
    });

    it('sends factory-reset to a connected device and removes it from the list', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomId, 'ToReset');

        const resetMsgPromise = esp32.waitForMessage('factory-reset', 2000);

        const listRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        const device = listRes.body.devices.find(d => d.name === 'ToReset');
        expect(device).toBeDefined();

        const res = await request(server.app)
          .post(`/api/rooms/${roomId}/esp32/${device.id}/reset`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const resetMsg = await resetMsgPromise;
        expect(resetMsg.type).toBe('factory-reset');

        await new Promise(resolve => setTimeout(resolve, 200));
        const verifyRes = await request(server.app)
          .get(`/api/rooms/${roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(verifyRes.body.devices.find(d => d.id === device.id)).toBeUndefined();
      } finally {
        await esp32.close();
      }
    });

    it('returns 404 for non-existent device', async () => {
      const { roomId, ownerToken } = await createRoom(server.app);
      const res = await request(server.app)
        .post(`/api/rooms/${roomId}/esp32/esp32_nonexistent/reset`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when device is in a different room', async () => {
      const roomA = await createRoom(server.app);
      const roomB = await createRoom(server.app);
      const esp32 = createESP32Client(server.port);
      try {
        await esp32.register(roomB.roomId, 'OtherRoomDevice');
        const listRes = await request(server.app)
          .get(`/api/rooms/${roomB.roomId}/esp32/devices`)
          .set('Authorization', `Bearer ${roomB.ownerToken}`);
        const device = listRes.body.devices.find(d => d.name === 'OtherRoomDevice');

        const res = await request(server.app)
          .post(`/api/rooms/${roomA.roomId}/esp32/${device.id}/reset`)
          .set('Authorization', `Bearer ${roomA.ownerToken}`);
        expect(res.status).toBe(404);
      } finally {
        await esp32.close();
      }
    });
  });
});
