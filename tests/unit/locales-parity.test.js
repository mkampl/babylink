// Web locale parity: every language has exactly the English key set, the
// same {placeholders} and the same HTML tags per string.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../../public/locales');
const LANGS = ['en', 'de', 'es', 'tr'];
const load = (l) => JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), 'utf8'));
const placeholders = (s) => (String(s).match(/\{[a-zA-Z_]+\}/g) || []).sort();
const tags = (s) => (String(s).match(/<\/?[a-z]+/gi) || []).map(t => t.toLowerCase()).sort();

const en = load('en');

describe('web locales', () => {
  for (const lang of LANGS.filter(l => l !== 'en')) {
    const other = load(lang);

    it(`${lang} has the same keys as en`, () => {
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
    });

    it(`${lang} keeps placeholders and HTML tags`, () => {
      for (const k of Object.keys(en)) {
        expect([k, placeholders(other[k])]).toEqual([k, placeholders(en[k])]);
        expect([k, tags(other[k])]).toEqual([k, tags(en[k])]);
      }
    });

    it(`${lang} has no empty strings`, () => {
      for (const k of Object.keys(en)) expect([k, String(other[k]).trim().length > 0]).toEqual([k, true]);
    });
  }
});
