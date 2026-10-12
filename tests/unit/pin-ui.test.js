// The server accepts 6–8 digit PINs (POST /api/rooms/:id/pin). The web UI
// must let users type all of them and must not describe a different range.
// The "current PIN" field was sent but never checked (the owner token
// authorises the change), so it is gone rather than pretending to protect.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'views/select-role.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/select-role.js'), 'utf8');
const input = (id) => (html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`)) || [''])[0];

describe('PIN inputs', () => {
  for (const id of ['pinInput', 'newPinInput']) {
    it(`${id} accepts 6–8 digits`, () => {
      const el = input(id);
      expect(el).toMatch(/maxlength="8"/);
      expect(el).toMatch(/pattern="\[0-9\]\{6,8\}"/);
      expect(el).toMatch(/inputmode="numeric"/);
    });
  }

  it('no unchecked "current PIN" field', () => {
    expect(html).not.toMatch(/currentPinInput/);
    expect(js).not.toMatch(/currentPin/);
  });

  it('no locale describes a 4–6 digit PIN', () => {
    for (const l of ['en', 'de', 'es', 'tr']) {
      const txt = fs.readFileSync(path.join(root, `public/locales/${l}.json`), 'utf8');
      expect([l, /4\s*[-–]\s*6|4- bis 6/.test(txt)]).toEqual([l, false]);
    }
  });
});
