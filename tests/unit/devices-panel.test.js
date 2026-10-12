// Owner devices panel: polling must be gentle on the shared rate limit, and
// the "disconnect" action must describe what it really does (the device
// reconnects on its own within seconds).

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const js = fs.readFileSync(path.join(root, 'public/js/select-role.js'), 'utf8');

describe('devices panel', () => {
  it('polls at most every 30 s and not while the page is hidden', () => {
    const m = js.match(/DEVICE_POLL_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(30000);
    expect(js).toMatch(/document\.hidden/);
  });

  it('the disconnect action is described as a temporary reconnect in every language', () => {
    for (const l of ['en', 'de', 'es', 'tr']) {
      const d = JSON.parse(fs.readFileSync(path.join(root, `public/locales/${l}.json`), 'utf8'));
      expect([l, /power cycle|Neustart|reiniciarse|açılışta/i.test(d.sr_confirm_disconnect)]).toEqual([l, false]);
    }
    const en = JSON.parse(fs.readFileSync(path.join(root, 'public/locales/en.json'), 'utf8'));
    expect(en.sr_confirm_disconnect).toMatch(/seconds/);
    expect(en.sr_disconnect).toBe('Reconnect');
  });
});
