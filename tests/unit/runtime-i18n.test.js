// Runtime strings built in JS must come from the locale files, and every key
// the code asks for must exist (a missing key renders as the raw key).

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'public/locales/en.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(root, 'public/js', f), 'utf8');

const FILES = ['app.js', 'home.js', 'select-role.js', 'multi-baby-ui.js', 'esp32-audio-handler.js',
  'wake-lock-manager.js', 'utils.js'];

describe('runtime i18n', () => {
  it('every key used from JS exists in en.json', () => {
    const missing = [];
    for (const f of FILES) {
      const src = read(f);
      const re = /(?:\bT|\b_t|i18n\.t|\btr)\(\s*'([a-z][a-z0-9_]*)'/g;
      let m;
      while ((m = re.exec(src))) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  const ENGLISH = {
    'app.js': ['Stop this baby monitor?', 'Leave this room?', 'Your browser will ask for the microphone',
      "'ICE connection failed'", "'Server disconnected'", "'Error: '"],
    'esp32-audio-handler.js': ['Tap anywhere to enable audio'],
    'wake-lock-manager.js': ['Screen Lock: Active', 'Screen Lock: Inactive', "'Release'", "'Retry'"],
    'utils.js': ["'Toggle dark mode'", "'Toggle dark/light mode'"],
    'home.js': ["'Server error '", "'Server did not return a roomId'"],
  };
  for (const [f, lits] of Object.entries(ENGLISH)) {
    it(`${f} has no hard-coded English UI strings`, () => {
      const src = read(f);
      for (const l of lits) expect([f, src.includes(l)]).toEqual([f, false]);
    });
  }
});
