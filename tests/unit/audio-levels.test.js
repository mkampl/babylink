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
