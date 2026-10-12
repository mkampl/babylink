// One shared threshold table for every place that turns an analyser peak
// into GREEN / YELLOW / RED: the parent's WebRTC meter, the parent's PCM
// (ESP32) meter, the baby-side crying detector and the sleep tracker.
// Before, the baby side used RED > 180 on the analyser's default -100..-30 dB
// window while the parent used RED > 130 on -40..-5 dB, so "crying" meant
// two different loudnesses.

const fs = require('fs');
const path = require('path');
const AudioLevels = require('../../public/js/audio-levels');

const JS = (f) => fs.readFileSync(path.join(__dirname, '../../public/js', f), 'utf8');

describe('AudioLevels table', () => {
  it('keeps the tuned parent-meter values', () => {
    expect(AudioLevels.MIN_DB).toBe(-40);
    expect(AudioLevels.MAX_DB).toBe(-5);
    expect(AudioLevels.thresholdsFor(1)).toEqual({ yellow: 60, red: 130 });
  });

  it('scales thresholds down at low sensitivity so RED stays reachable', () => {
    expect(AudioLevels.thresholdsFor(0.5)).toEqual({ yellow: 30, red: 65 });
    expect(AudioLevels.thresholdsFor(2)).toEqual({ yellow: 60, red: 130 });
    expect(AudioLevels.thresholdsFor(undefined)).toEqual({ yellow: 60, red: 130 });
  });

  it('classify applies sensitivity to the reading', () => {
    expect(AudioLevels.classify(50, 1)).toBe('GREEN');
    expect(AudioLevels.classify(61, 1)).toBe('YELLOW');
    expect(AudioLevels.classify(131, 1)).toBe('RED');
    expect(AudioLevels.classify(70, 2)).toBe('RED');
  });

  it('configureAnalyser sets the shared dB window', () => {
    const a = {};
    AudioLevels.configureAnalyser(a);
    expect(a.minDecibels).toBe(-40);
    expect(a.maxDecibels).toBe(-5);
  });
});

describe('every detector uses the shared table', () => {
  for (const f of ['multi-stream-manager.js', 'esp32-audio-handler.js', 'app.js', 'sleep-tracker.js']) {
    it(`${f} has no private threshold literals`, () => {
      const src = JS(f);
      expect(src).toMatch(/AudioLevels\./);
      expect(src).not.toMatch(/RED_THRESHOLD|YELLOW_THRESHOLD|redThreshold = 130|let yellow = 60|baseRed\s*=\s*130/);
      expect(src).not.toMatch(/minDecibels\s*=\s*-40/);
    });
  }

  it('audio-levels.js loads before its users on the monitor page', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../views/webrtc.html'), 'utf8');
    const at = (s) => html.indexOf(`/js/${s}`);
    expect(at('audio-levels.js')).toBeGreaterThan(-1);
    for (const f of ['multi-stream-manager.js', 'esp32-audio-handler.js', 'sleep-tracker.js', 'app.js']) {
      expect(at('audio-levels.js')).toBeLessThan(at(f));
    }
  });
});

// ESP devices stream raw PCM. Their meter reads the time-domain peak of each
// chunk as it ARRIVES (like the Android app), not an FFT bin after the
// playout jitter buffer — that read far too low (a -4 dBFS cry only reached
// YELLOW) and lagged by whatever the buffer held.
describe('PCM peak scale (ESP meter, matches the Android app)', () => {
  it('pcmPeak is the max |sample| as a 0..1 fraction of full scale', () => {
    expect(AudioLevels.pcmPeak(new Int16Array([0, 100, -16384, 50]))).toBeCloseTo(0.5, 5);
    expect(AudioLevels.pcmPeak(new Int16Array([-32768]))).toBe(1);
    expect(AudioLevels.pcmPeak(new Int16Array([]))).toBe(0);
  });

  it('maps the Android bands onto the shared thresholds: 0.12 -> YELLOW, 0.5 -> RED', () => {
    expect(AudioLevels.fromPcmPeak(0)).toBe(0);
    expect(AudioLevels.fromPcmPeak(0.12)).toBeCloseTo(AudioLevels.YELLOW, 5);
    expect(AudioLevels.fromPcmPeak(0.5)).toBeCloseTo(AudioLevels.RED, 5);
    expect(AudioLevels.fromPcmPeak(1)).toBe(255);
    expect(AudioLevels.fromPcmPeak(2)).toBe(255);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const v = AudioLevels.fromPcmPeak(p);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('classifies like the Android app at sensitivity 1', () => {
    const band = (p) => AudioLevels.classify(AudioLevels.fromPcmPeak(p), 1);
    expect(band(0.05)).toBe('GREEN');
    expect(band(0.11)).toBe('GREEN');
    expect(band(0.13)).toBe('YELLOW');
    expect(band(0.3)).toBe('YELLOW');
    expect(band(0.51)).toBe('RED');
    expect(band(0.6)).toBe('RED');
  });

  it('below the YELLOW knee, sensitivity scales exactly like the Android app (level x s)', () => {
    // Android: YELLOW when peak * s >= 0.12.
    expect(AudioLevels.classify(AudioLevels.fromPcmPeak(0.07), 2)).toBe('YELLOW'); // 0.14
    expect(AudioLevels.classify(AudioLevels.fromPcmPeak(0.05), 2)).toBe('GREEN');  // 0.10
  });
});
