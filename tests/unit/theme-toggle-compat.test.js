// Regression: ThemeManager.createToggleButton must not throw on older Safari
// (iOS < 14), whose MediaQueryList has the legacy addListener but NOT the
// modern addEventListener. The throw there aborted the whole home-page script,
// which left the Create Room form handler unattached so clicking it did a
// native form submit and reloaded the start page. See views/index.html guards.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load utils.js into a sandbox with a mock window/document, returning both the
// ThemeManager and a record of which MediaQueryList API was used.
function loadWithMatchMedia(makeMql) {
  const used = { addEventListener: 0, addListener: 0 };
  function fakeEl() {
    return {
      className: '', title: '', textContent: '',
      setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, appendChild() {},
    };
  }
  const sandbox = {
    window: { matchMedia: () => makeMql(used) },
    document: {
      documentElement: { setAttribute() {}, getAttribute() { return null; } },
      createElement: fakeEl,
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '../../public/js/utils.js'), 'utf8')
    + '\nglobalThis.__ThemeManager = ThemeManager;';
  vm.runInContext(code, sandbox);
  return { ThemeManager: sandbox.__ThemeManager, used };
}

const legacyMql = (used) => ({
  matches: false,
  addListener(fn) { used.addListener++; this._fn = fn; },
  // no addEventListener — this is the old-Safari shape
});

const modernMql = (used) => ({
  matches: false,
  addEventListener(_ev, fn) { used.addEventListener++; this._fn = fn; },
  addListener(fn) { used.addListener++; this._fn = fn; },
});

describe('ThemeManager.createToggleButton — matchMedia compatibility', () => {
  it('does NOT throw on legacy MediaQueryList (old Safari) and uses addListener', () => {
    const { ThemeManager, used } = loadWithMatchMedia(legacyMql);
    const container = { appendChild() {} };
    expect(() => ThemeManager.createToggleButton(container)).not.toThrow();
    expect(used.addListener).toBe(1);
    expect(used.addEventListener).toBe(0);
  });

  it('prefers addEventListener on modern MediaQueryList', () => {
    const { ThemeManager, used } = loadWithMatchMedia(modernMql);
    const container = { appendChild() {} };
    expect(() => ThemeManager.createToggleButton(container)).not.toThrow();
    expect(used.addEventListener).toBe(1);
    expect(used.addListener).toBe(0);
  });
});
