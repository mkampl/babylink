/**
 * Validate all served JavaScript files parse correctly.
 * This catches syntax errors like missing braces that break the browser.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { startServer } = require('../helpers/server-factory');
const request = require('supertest');

let server;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

// All JS files that are loaded by HTML pages
const JS_FILES = [
  '/js/utils.js',
  '/js/multi-baby-ui.js',
  '/js/multi-stream-manager.js',
  '/js/wake-lock-manager.js',
  '/js/alarm-manager.js',
  '/js/esp32-audio-handler.js',
  '/js/notification-ui.js',
  '/js/app.js',
];

describe('JavaScript file syntax validation', () => {
  JS_FILES.forEach(file => {
    it(`${file} has valid syntax`, () => {
      const filePath = path.join(__dirname, '../../public', file);
      const code = fs.readFileSync(filePath, 'utf8');

      // vm.compileFunction throws SyntaxError if code is invalid
      // We wrap in a function body since these are script-level files, not modules
      expect(() => {
        new vm.Script(code, { filename: file });
      }).not.toThrow();
    });

    it(`${file} is served by the server`, async () => {
      const res = await request(server.app).get(file);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
    });
  });

  it('multi-baby-ui.js defines MultiBabyUI class with proper closing', () => {
    const filePath = path.join(__dirname, '../../public/js/multi-baby-ui.js');
    const code = fs.readFileSync(filePath, 'utf8');
    expect(code).toContain('class MultiBabyUI');
    // Class must be properly closed — verify by checking brace balance
    // between 'class MultiBabyUI' and the export statement
    const classStart = code.indexOf('class MultiBabyUI');
    const exportStart = code.indexOf('if (typeof module');
    const classBody = code.substring(classStart, exportStart);
    const opens = (classBody.match(/{/g) || []).length;
    const closes = (classBody.match(/}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('multi-stream-manager.js defines MultiStreamManager class', () => {
    const filePath = path.join(__dirname, '../../public/js/multi-stream-manager.js');
    const code = fs.readFileSync(filePath, 'utf8');
    expect(code).toContain('class MultiStreamManager');
  });

  it('utils.js defines escapeHtml function', () => {
    const filePath = path.join(__dirname, '../../public/js/utils.js');
    const code = fs.readFileSync(filePath, 'utf8');
    expect(code).toContain('function escapeHtml');
  });

  it('utils.js defines ThemeManager', () => {
    const filePath = path.join(__dirname, '../../public/js/utils.js');
    const code = fs.readFileSync(filePath, 'utf8');
    expect(code).toContain('ThemeManager');
  });
});

describe('HTML pages reference all required scripts', () => {
  it('webrtc.html loads utils.js, multi-baby-ui.js, multi-stream-manager.js', async () => {
    const roomId = 'a'.repeat(32);
    const res = await request(server.app).get(`/${roomId}?role=parent`);
    expect(res.text).toContain('/js/utils.js');
    expect(res.text).toContain('/js/multi-baby-ui.js');
    expect(res.text).toContain('/js/multi-stream-manager.js');
  });

  it('webrtc.html loads app.js (which calls initialize)', async () => {
    const roomId = 'a'.repeat(32);
    const res = await request(server.app).get(`/${roomId}?role=parent`);
    expect(res.text).toContain('/js/app.js');
    // app.js must contain initialize() call
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
    expect(appJs).toContain('initialize()');
    expect(appJs).not.toContain("DOMContentLoaded");
  });

  it('webrtc.html loads external CSS files', async () => {
    const roomId = 'a'.repeat(32);
    const res = await request(server.app).get(`/${roomId}?role=parent`);
    expect(res.text).toContain('css/variables.css');
    expect(res.text).toContain('css/base.css');
    expect(res.text).toContain('css/components.css');
    expect(res.text).toContain('css/monitor.css');
  });

  it('index.html loads utils.js', async () => {
    const res = await request(server.app).get('/');
    expect(res.text).toContain('/js/utils.js');
  });

  it('select-role.html loads utils.js', async () => {
    const roomId = 'a'.repeat(32);
    const res = await request(server.app).get(`/${roomId}`);
    expect(res.text).toContain('/js/utils.js');
  });
});
