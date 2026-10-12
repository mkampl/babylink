// Meter arbitration between the WebRTC path (multi-stream-manager) and the
// PCM path (esp32-audio-handler). Both decide who drives the baby-card badge
// from the shared AudioHealth.webrtcDelivering() flag, so exactly one path
// owns the meter at any instant (no red/green flicker).
//
// The WebRTC loop must FEED that flag (markWebrtcLevel) on every frame before
// it decides whether to drive the badge. If it gates first, the flag can
// never become true and a WebRTC-only baby (phone/browser) never gets a
// meter, auto-unmute, crying alert or stall display.

const MultiStreamManager = require('../../public/js/multi-stream-manager');
const AudioHealth = require('../../public/js/audio-health');
const LevelMeter = require('../../public/js/level-meter');
globalThis.AudioLevels = require('../../public/js/audio-levels');

let registry;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  registry = new Map();
  globalThis.getAudioHealth = (id) => {
    if (!registry.has(id)) registry.set(id, new AudioHealth());
    return registry.get(id);
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.getAudioHealth;
});

// An AnalyserNode stand-in whose spectrum peak we control.
function fakeAnalyser(state) {
  return {
    frequencyBinCount: 128,
    getByteFrequencyData(arr) { arr.fill(0); arr[5] = state.peak; },
  };
}

function liveStream() {
  return { getAudioTracks: () => [{ muted: false, readyState: 'live' }] };
}

function attach(mgr, id, state) {
  mgr.audioStreams.set(id, liveStream());
  const analyser = fakeAnalyser(state);
  mgr.analysers.set(id, {
    analyser,
    dataArray: new Uint8Array(analyser.frequencyBinCount),
    meter: new LevelMeter(),
    currentLevel: 'GREEN',
  });
  mgr.monitorAudioLevel(id);
}

describe('WebRTC meter loop', () => {
  it('drives the badge for a WebRTC-only baby that has sound', () => {
    const mgr = new MultiStreamManager({}, {});
    const updates = [];
    mgr.onAudioLevelUpdate = (id, level, volume) => updates.push({ id, level, volume });
    const state = { peak: 200 };
    attach(mgr, 'phone-baby', state);

    vi.advanceTimersByTime(1000);

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].level).toBe('RED');
    expect(registry.get('phone-baby').webrtcDelivering(Date.now())).toBe(true);
  });

  it('a quiet WebRTC-only baby still owns its badge and is "quiet", not stalled', () => {
    const mgr = new MultiStreamManager({}, {});
    const updates = [];
    mgr.onAudioLevelUpdate = (id, level) => updates.push(level);
    attach(mgr, 'phone-baby', { peak: 0 });
    vi.advanceTimersByTime(1000);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toBe('GREEN');
    expect(registry.get('phone-baby').status(Date.now())).toBe('quiet');
  });

  it('a WebRTC-only baby whose track died is reported stalled', () => {
    const mgr = new MultiStreamManager({}, {});
    attach(mgr, 'phone-baby', { peak: 0 });
    vi.advanceTimersByTime(500);
    mgr.audioStreams.set('phone-baby',
      { getAudioTracks: () => [{ muted: true, readyState: 'live' }] });
    vi.advanceTimersByTime(AudioHealth.DEFAULTS.stallMs + 500);
    expect(registry.get('phone-baby').status(Date.now())).toBe('stalled');
  });

  it('ESP (both paths): feeds health while silent, but yields the badge to PCM', () => {
    const mgr = new MultiStreamManager({}, {});
    const updates = [];
    mgr.onAudioLevelUpdate = (id, level) => updates.push(level);
    const state = { peak: 200 };
    attach(mgr, 'esp', state);
    const pcm = setInterval(() => globalThis.getAudioHealth('esp').markPcmFrame(Date.now()), 66);
    vi.advanceTimersByTime(500);
    const before = updates.length;
    expect(before).toBeGreaterThan(0);

    // WebRTC goes silent (wedged tunnel) while PCM frames keep arriving:
    // after the delivery window the PCM path owns the badge.
    state.peak = 0;
    vi.advanceTimersByTime(AudioHealth.DEFAULTS.webrtcWindowMs + 300);
    const settled = updates.length;
    vi.advanceTimersByTime(1000);
    expect(updates.length).toBe(settled);
    expect(registry.get('esp').status(Date.now())).not.toBe('webrtc');

    // Sound comes back on WebRTC → it takes the badge again.
    state.peak = 200;
    vi.advanceTimersByTime(300);
    expect(updates.length).toBeGreaterThan(settled);
    clearInterval(pcm);
  });
});

describe('partition: exactly one path drives the badge', () => {
  it('for every recent-energy history, WebRTC drives iff PCM yields', () => {
    for (const lastWebrtcAgo of [0, 100, 899, 900, 2000, Infinity]) {
      const h = new AudioHealth();
      const now = 50_000;
      h.markPcmFrame(now - 50); // a device with a PCM path
      if (lastWebrtcAgo !== Infinity) h.markWebrtcLevel(now - lastWebrtcAgo, 200);
      const webrtcDrives = h.webrtcOwnsMeter(now);    // multi-stream emits
      const pcmDrives = !h.webrtcDelivering(now);     // esp32 handler emits
      expect(webrtcDrives !== pcmDrives).toBe(true);
    }
  });
});
