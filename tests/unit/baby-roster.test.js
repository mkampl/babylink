// Parent-side bookkeeping of which babies are present and which dropped out.
// A baby that leaves keeps its card (shown as disconnected) and raises the
// alarm — even when other babies are still connected — until it returns.
// ESP32s come back under the same id; phone/browser babies come back under
// a new socket id but the same name, which replaces the stale card.

const BabyRoster = require('../../public/js/baby-roster');

describe('BabyRoster', () => {
  it('alarms when one of two babies leaves', () => {
    const r = new BabyRoster();
    r.joined('a', 'Anna');
    r.joined('b', 'Ben');
    r.left('a');
    expect(r.isGone('a')).toBe(true);
    expect(r.shouldAlarm()).toBe(true);
    expect(r.goneNames()).toEqual(['Anna']);
  });

  it('a device returning under the same id revives its card and clears the alarm', () => {
    const r = new BabyRoster();
    r.joined('esp32_aa', 'Nursery');
    r.left('esp32_aa');
    const res = r.joined('esp32_aa', 'Nursery');
    expect(res).toEqual({ revived: true, replaced: [] });
    expect(r.shouldAlarm()).toBe(false);
  });

  it('a phone baby returning under a new id replaces its stale card', () => {
    const r = new BabyRoster();
    r.joined('sock1', 'Emma');
    r.left('sock1');
    const res = r.joined('sock2', 'Emma');
    expect(res).toEqual({ revived: false, replaced: ['sock1'] });
    expect(r.shouldAlarm()).toBe(false);
  });

  it('an unrelated new baby does not clear another baby\'s alarm', () => {
    const r = new BabyRoster();
    r.joined('sock1', 'Emma');
    r.left('sock1');
    r.joined('sock2', 'Noah');
    expect(r.shouldAlarm()).toBe(true);
  });

  it('forget() drops a card the user dismissed; clear() resets on reconnect', () => {
    const r = new BabyRoster();
    r.joined('a', 'A'); r.left('a');
    r.forget('a');
    expect(r.shouldAlarm()).toBe(false);
    r.joined('b', 'B'); r.left('b');
    r.clear();
    expect(r.shouldAlarm()).toBe(false);
    expect(r.isGone('b')).toBe(false);
  });

  it('leaving twice or leaving unknown ids is harmless', () => {
    const r = new BabyRoster();
    r.left('nobody');               // never seen → nothing to alarm about
    expect(r.isGone('nobody')).toBe(false);
    r.joined('x', 'X'); r.left('x'); r.left('x');
    expect(r.goneNames()).toEqual(['X']);
  });
});
