// The ESP card meter (esp32-audio-handler) reads the peak of each raw PCM
// chunk as it ARRIVES — the Android app's metric — not an AnalyserNode placed
// after the AudioWorklet jitter buffer. That analyser read sat behind whatever
// the buffer held (one WiFi stall added ~300 ms that never went away) and its
// FFT-bin scale showed a near-full-scale cry as YELLOW ("far too quiet and far
// too late"). The analyser still feeds audio health (energy) as before.

const AudioHealth = require('../../public/js/audio-health');
globalThis.LevelMeter = require('../../public/js/level-meter');
globalThis.AudioLevels = require('../../public/js/audio-levels');
const ESP32AudioHandler = require('../../public/js/esp32-audio-handler');

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

function chunk(peak, n = 1024) {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i / 3) * peak * 32767);
  return a;
}

// A handler with one ESP context already set up (no real Web Audio). The
// analyser stands for the jitter-buffer OUTPUT and stays silent, as it does
// while the buffer is still filling.
function setup() {
  const contexts = new Map();
  const handler = new ESP32AudioHandler(contexts);
  const ui = { babyCards: new Map([['esp', {}]]), updates: [],
    updateAudioLevel(id, level, volume) { this.updates.push({ level, volume }); } };
  contexts.set('esp', {
    audioContext: { state: 'running' },
    analyser: { getByteFrequencyData(arr) { arr.fill(0); } },
    levelData: new Uint8Array(128),
    meter: handler._createMeter(),
    worklet: { port: { postMessage() {} } },
    arbGain: { gain: { value: 1 } },
    workletReady: true,
    sampleRate: 16000,
    channels: 1,
  });
  handler.multiBabyUI = ui;
  handler._startLevelMonitor('esp');
  const send = (peak) => handler.handleAudioData(
    { fromId: 'esp', audio: chunk(peak).buffer, sampleRate: 16000, channels: 1 }, ui);
  return { handler, ui, send };
}

const last = (ui) => ui.updates[ui.updates.length - 1];

describe('ESP meter reads the PCM peak at arrival', () => {
  it('a loud chunk shows RED on the next tick, before the jitter buffer outputs anything', () => {
    const { ui, send } = setup();
    send(0.6);
    vi.advanceTimersByTime(100);
    expect(last(ui).level).toBe('RED');
  });

  it('bands match the Android app: 0.3 → YELLOW, 0.05 → GREEN', () => {
    const a = setup();
    for (let t = 0; t < 10; t++) { a.send(0.3); vi.advanceTimersByTime(64); }
    expect(last(a.ui).level).toBe('YELLOW');

    const b = setup();
    for (let t = 0; t < 10; t++) { b.send(0.05); vi.advanceTimersByTime(64); }
    expect(last(b.ui).level).toBe('GREEN');
  });

  it('the bar height follows the peak (a 0.6 cry fills well over half the meter)', () => {
    const { ui, send } = setup();
    for (let t = 0; t < 10; t++) { send(0.6); vi.advanceTimersByTime(64); }
    expect(last(ui).volume / 255).toBeGreaterThan(0.55);
  });

  it('does not dip to zero on a tick that saw no new chunk (64 ms chunks vs 100 ms ticks)', () => {
    const { ui, send } = setup();
    for (let t = 0; t < 30; t++) { send(0.6); vi.advanceTimersByTime(64); }
    const levels = ui.updates.slice(3).map((u) => u.level);
    expect(levels.every((l) => l === 'RED')).toBe(true);
  });

  it('falls back to quiet once chunks stop being loud', () => {
    const { ui, send } = setup();
    for (let t = 0; t < 10; t++) { send(0.6); vi.advanceTimersByTime(64); }
    for (let t = 0; t < 40; t++) { send(0.01); vi.advanceTimersByTime(64); }
    expect(last(ui).level).toBe('GREEN');
  });

  it('yields the badge when PCM stops arriving (WebRTC takes over)', () => {
    const { ui, send } = setup();
    send(0.6);
    vi.advanceTimersByTime(300);
    const n = ui.updates.length;
    vi.advanceTimersByTime(AudioHealth.DEFAULTS.stallMs + 500);
    // a few ticks of hold/decay, then nothing once PCM is no longer arriving
    const after = ui.updates.length;
    vi.advanceTimersByTime(1000);
    expect(ui.updates.length).toBe(after);
    expect(after).toBeGreaterThanOrEqual(n);
  });
});
