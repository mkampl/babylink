// Shared GREEN / YELLOW / RED thresholds for every audio detector.
//
// Used by the parent's WebRTC meter (multi-stream-manager), the parent's PCM
// meter for ESP32 devices (esp32-audio-handler), the baby-side crying
// detector (app.js) and the sleep tracker, so "crying" means the same
// loudness everywhere and the badge means one thing whichever transport is
// live.
//
// Values: an AnalyserNode peak (getByteFrequencyData, 0..255) on a
// -40..-5 dB window. YELLOW > 60 (≈ -32 dB) and RED > 130 (≈ -22 dB) are the
// values the parent meter has been tuned to. The baby side used to compare
// against RED > 180 on the analyser's default -100..-30 dB window
// (≈ -51 dB), i.e. it flagged much quieter sound as crying than the parent
// card ever showed red; it now follows the parent's tuning.
//
// Sensitivity (0.5..3) scales the READING, never the audio. Below ~0.71 the
// thresholds scale down too so RED stays reachable with a quiet microphone.
// The server-side ESP32 detection baseline is not involved (see
// server/esp32-proxy.js — the server no longer inspects audio).

(function (global) {
  'use strict';

  const AudioLevels = {
    MIN_DB: -40,
    MAX_DB: -5,
    YELLOW: 60,
    RED: 130,
    LOW_SENSITIVITY: 0.71,

    thresholdsFor(sensitivity) {
      const s = sensitivity || 1;
      if (s < this.LOW_SENSITIVITY) {
        return { yellow: this.YELLOW * s, red: this.RED * s };
      }
      return { yellow: this.YELLOW, red: this.RED };
    },

    /** Instant classification (no smoothing) of a raw analyser peak. */
    classify(peak, sensitivity) {
      const s = sensitivity || 1;
      const { yellow, red } = this.thresholdsFor(s);
      const v = peak * s;
      if (v > red) return 'RED';
      if (v > yellow) return 'YELLOW';
      return 'GREEN';
    },

    configureAnalyser(analyser) {
      analyser.minDecibels = this.MIN_DB;
      analyser.maxDecibels = this.MAX_DB;
      return analyser;
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioLevels;
  } else {
    global.AudioLevels = AudioLevels;
  }
})(typeof window !== 'undefined' ? window : globalThis);
