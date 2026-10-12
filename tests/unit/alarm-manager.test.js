// The disconnect alarm must be audible on iOS/Safari: its AudioContext has
// to be created (or resumed) inside a user gesture. Creating it lazily in
// play() — which runs from a socket event, not a tap — leaves it suspended
// and the alarm silent.

const AlarmManager = require('../../public/js/alarm-manager');

function fakeCtxClass(log) {
  return class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; log.created++; }
    resume() { log.resumed++; this.state = 'running'; return Promise.resolve(); }
    createOscillator() { return { connect() {}, frequency: {}, start() {}, stop() {} }; }
    createGain() {
      return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    }
  };
}

let log;
beforeEach(() => {
  vi.useFakeTimers();
  log = { created: 0, resumed: 0 };
  globalThis.window = { AudioContext: fakeCtxClass(log) };
});
afterEach(() => { vi.useRealTimers(); delete globalThis.window; });

describe('AlarmManager', () => {
  it('unlock() (called from the Start Monitoring tap) creates and resumes the context', () => {
    const a = new AlarmManager();
    a.unlock();
    expect(log.created).toBe(1);
    expect(log.resumed).toBe(1);
    expect(a.audioContext.state).toBe('running');
  });

  it('play() reuses the unlocked context instead of creating one outside a gesture', () => {
    const a = new AlarmManager();
    a.unlock();
    a.play();
    expect(log.created).toBe(1);
    a.stop();
  });

  it('play() resumes a context the browser suspended in the meantime', () => {
    const a = new AlarmManager();
    a.unlock();
    a.audioContext.state = 'suspended';
    a.play();
    expect(log.resumed).toBe(2);
    a.stop();
  });
});
