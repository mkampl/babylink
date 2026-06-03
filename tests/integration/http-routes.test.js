const request = require('supertest');
const { startServer } = require('../helpers/server-factory');
const { VALID_ROOM_ID, INVALID_ROOM_IDS } = require('../helpers/constants');

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('GET /', () => {
  it('returns 200 with HTML', async () => {
    const res = await request(server.app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('contains BabyLink content', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('BabyLink');
  });

  it('contains onboarding wizard', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('id="onboarding"');
    expect(res.text).toContain('onboarding-step');
    expect(res.text).toContain('Welcome to BabyLink');
    expect(res.text).toContain('Create Your First Room');
    expect(res.text).toContain('Connect Your Devices');
  });

  it('has onboarding progress dots for 3 steps', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('data-step="0"');
    expect(res.text).toContain('data-step="1"');
    expect(res.text).toContain('data-step="2"');
  });

  it('has help button to replay onboarding', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('id="helpBtn"');
    expect(res.text).toContain('replayOnboarding()');
  });

  it('checks localStorage for onboarding-complete', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('babylink-onboarding-complete');
  });

  it('still contains the main home page sections', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('id="homeMain"');
    expect(res.text).toContain('createRoomForm');
    expect(res.text).toContain('joinRoomForm');
    expect(res.text).toContain('previousRoomsSection');
  });
});

describe('GET /health', () => {
  it('returns 200 with JSON', async () => {
    const res = await request(server.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('includes all required fields', async () => {
    const res = await request(server.app).get('/health');
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('rooms');
    expect(res.body).toHaveProperty('esp32Devices');
    expect(res.body).toHaveProperty('version');
  });

  it('status is healthy', async () => {
    const res = await request(server.app).get('/health');
    expect(res.body.status).toBe('healthy');
  });

  it('rooms is 0 on fresh server', async () => {
    const res = await request(server.app).get('/health');
    expect(res.body.rooms).toBe(0);
  });

  it('esp32Devices is 0 on fresh server', async () => {
    const res = await request(server.app).get('/health');
    expect(res.body.esp32Devices).toBe(0);
  });

  it('version matches package.json', async () => {
    const res = await request(server.app).get('/health');
    expect(res.body.version).toBe('1.0.0');
  });
});

describe('GET /api/config/webrtc', () => {
  it('returns 200 with ICE servers', async () => {
    const res = await request(server.app).get('/api/config/webrtc');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('iceServers');
    expect(Array.isArray(res.body.iceServers)).toBe(true);
  });

  it('includes STUN server', async () => {
    const res = await request(server.app).get('/api/config/webrtc');
    expect(res.body.iceServers[0].urls).toContain('stun:');
  });
});

describe('GET /api/esp32/status', () => {
  it('returns 200 with stats', async () => {
    const res = await request(server.app).get('/api/esp32/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalClients');
  });

  it('totalClients is 0 on fresh server', async () => {
    const res = await request(server.app).get('/api/esp32/status');
    expect(res.body.totalClients).toBe(0);
    expect(res.body.clients).toEqual([]);
  });
});

describe('GET /:roomId (valid room, no role)', () => {
  it('returns 200 with role selection page', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('role');
  });
});

describe('GET /:roomId?role=baby', () => {
  it('returns 200 with webrtc page', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}?role=baby`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('BabyLink');
  });

  it('sets Cache-Control no-cache headers', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}?role=baby`);
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['expires']).toBe('0');
  });
});

describe('GET /:roomId?role=parent', () => {
  it('returns 200 with webrtc page', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}?role=parent`);
    expect(res.status).toBe(200);
  });
});

describe('GET /:roomId with invalid roomId', () => {
  it('rejects short roomId with 400', async () => {
    const res = await request(server.app).get('/abc');
    expect(res.status).toBe(400);
  });

  it('rejects non-hex roomId with 400', async () => {
    const res = await request(server.app).get(`/${'g'.repeat(32)}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /:roomId?role=invalid', () => {
  it('rejects invalid role with 400', async () => {
    const res = await request(server.app).get(`/${VALID_ROOM_ID}?role=observer`);
    expect(res.status).toBe(400);
  });
});

describe('POST /:roomId', () => {
  it('redirects with valid baby role', async () => {
    const res = await request(server.app)
      .post(`/${VALID_ROOM_ID}`)
      .send('role=baby');
    expect(res.status).toBe(302);
  });

  it('redirects with valid parent role', async () => {
    const res = await request(server.app)
      .post(`/${VALID_ROOM_ID}`)
      .send('role=parent');
    expect(res.status).toBe(302);
  });

  it('rejects missing role with 400', async () => {
    const res = await request(server.app)
      .post(`/${VALID_ROOM_ID}`)
      .send('');
    expect(res.status).toBe(400);
  });

  it('rejects invalid role with 400', async () => {
    const res = await request(server.app)
      .post(`/${VALID_ROOM_ID}`)
      .send('role=admin');
    expect(res.status).toBe(400);
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(server.app).get('/nonexistent/path/here');
    expect(res.status).toBe(404);
  });

  it('returns JSON error', async () => {
    const res = await request(server.app).get('/nonexistent/path/here');
    expect(res.body.error).toBe('Not found');
  });
});

describe('Static files', () => {
  it('serves css/base.css', async () => {
    const res = await request(server.app).get('/css/base.css');
    expect(res.status).toBe(200);
  });

  it('serves manifest.json', async () => {
    const res = await request(server.app).get('/manifest.json');
    expect(res.status).toBe(200);
  });

  it('serves service-worker.js', async () => {
    const res = await request(server.app).get('/service-worker.js');
    expect(res.status).toBe(200);
  });
});
