// Browsers throttle timers in background tabs (Chrome: heavily after ~5 min
// unless the page is audibly playing). A parent monitor whose babies are
// auto-muted is not audible, so its meters, crying detection and alarm can
// stall while hidden. The page can't prevent that reliably, so it tells the
// parent when they come back after a long absence.

const BackgroundWatch = require('../../public/js/background-watch');

describe('BackgroundWatch', () => {
  it('warns after a long time hidden', () => {
    const w = new BackgroundWatch({ warnAfterMs: 60_000 });
    w.hidden(0);
    expect(w.visible(61_000)).toBe(true);
  });

  it('does not warn after a short switch away', () => {
    const w = new BackgroundWatch({ warnAfterMs: 60_000 });
    w.hidden(0);
    expect(w.visible(5_000)).toBe(false);
  });

  it('a visible event without a prior hidden one never warns', () => {
    const w = new BackgroundWatch();
    expect(w.visible(10 ** 9)).toBe(false);
  });

  it('warns once per absence', () => {
    const w = new BackgroundWatch({ warnAfterMs: 1000 });
    w.hidden(0);
    expect(w.visible(5000)).toBe(true);
    expect(w.visible(9000)).toBe(false);
  });
});
