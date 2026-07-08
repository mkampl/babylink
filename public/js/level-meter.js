// Shared level-meter dynamics for the baby-card audio meter.
//
// Both audio paths (WebRTC via multi-stream-manager, raw PCM via
// esp32-audio-handler) feed their per-frame analyser peak through one
// LevelMeter so the badge behaves identically regardless of transport.
//
// It fixes two field-reported problems:
//
//   1. Latency (~1s): the AnalyserNode's own smoothingTimeConstant was high
//      (0.8/0.6). At a 100 ms read cadence that needs ~10 frames to rise to
//      full scale — about a second — so the meter lagged audio that was
//      already audible. We drop the analyser smoothing to near-zero and do
//      our own envelope here with a FAST ATTACK: the meter now jumps on the
//      first loud frame.
//
//   2. Flicker: a signal sitting near a threshold flipped GREEN/YELLOW/RED
//      every frame. We add (a) a SLOW RELEASE so the envelope eases down
//      instead of snapping, (b) HYSTERESIS — you must exceed an enter
//      threshold to climb but fall below a lower exit threshold to drop, and
//      (c) a MINIMUM HOLD so a level can't be abandoned for a few hundred ms.
//      Rising is always immediate; only falling is damped.
//
// Pure and time-injectable (`now` is passed in), so the dynamics can be
// unit-tested against synthetic signals with no browser or microphone —
// see tests/unit/level-meter.test.js.

(function (global) {
  'use strict';

  const RANK = { GREEN: 0, YELLOW: 1, RED: 2 };

  const DEFAULTS = {
    // Envelope coefficients per frame (~100 ms). attack≈0.6 reaches 94% in
    // three frames (~0.3 s); release≈0.12 decays over ~0.8 s.
    attack: 0.6,
    release: 0.12,
    // Exit threshold as a fraction of the enter threshold (hysteresis band).
    exitRatio: 0.72,
    // A level cannot be given up until it has been held this long (ms).
    minHoldMs: 450,
  };

  class LevelMeter {
    constructor(opts) {
      opts = opts || {};
      this.attack = opts.attack != null ? opts.attack : DEFAULTS.attack;
      this.release = opts.release != null ? opts.release : DEFAULTS.release;
      this.exitRatio = opts.exitRatio != null ? opts.exitRatio : DEFAULTS.exitRatio;
      this.minHoldMs = opts.minHoldMs != null ? opts.minHoldMs : DEFAULTS.minHoldMs;

      this.env = 0;           // smoothed envelope value (0..255+)
      this.level = 'GREEN';   // current committed level
      this.levelSince = null; // timestamp the current level was entered
    }

    /**
     * Advance the meter by one analyser frame.
     * @param {number} raw    peak this frame, already sensitivity-adjusted (0..255)
     * @param {number} yellow enter threshold for YELLOW
     * @param {number} red    enter threshold for RED
     * @param {number} now    monotonic timestamp in ms
     * @returns {{level: string, volume: number}}
     */
    push(raw, yellow, red, now) {
      if (!(raw >= 0)) raw = 0;
      if (this.levelSince == null) this.levelSince = now;

      // Envelope follower: fast attack (rise), slow release (fall).
      const coeff = raw > this.env ? this.attack : this.release;
      this.env = this.env + (raw - this.env) * coeff;
      const v = this.env;

      const yellowExit = yellow * this.exitRatio;
      const redExit = red * this.exitRatio;

      // Where does the envelope want the level to be, with hysteresis?
      let target = this.level;
      if (this.level === 'GREEN') {
        if (v > red) target = 'RED';
        else if (v > yellow) target = 'YELLOW';
      } else if (this.level === 'YELLOW') {
        if (v > red) target = 'RED';
        else if (v < yellowExit) target = 'GREEN';
      } else { // RED
        if (v < redExit) target = (v < yellowExit) ? 'GREEN' : 'YELLOW';
      }

      // Rising commits immediately; falling waits out the minimum hold.
      if (RANK[target] > RANK[this.level]) {
        this.level = target;
        this.levelSince = now;
      } else if (RANK[target] < RANK[this.level]) {
        if (now - this.levelSince >= this.minHoldMs) {
          // Step down one rank at a time so RED→GREEN passes through YELLOW
          // rather than snapping, which also re-arms the hold.
          const next = RANK[this.level] - 1;
          this.level = next <= RANK[target] ? target
                      : (next === 1 ? 'YELLOW' : 'GREEN');
          this.levelSince = now;
        }
      }

      return { level: this.level, volume: Math.min(255, Math.round(v)) };
    }

    /** Reset to silence (e.g. on reconnect). */
    reset() {
      this.env = 0;
      this.level = 'GREEN';
      this.levelSince = null;
    }
  }

  LevelMeter.DEFAULTS = DEFAULTS;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LevelMeter;
  } else {
    global.LevelMeter = LevelMeter;
  }
})(typeof window !== 'undefined' ? window : globalThis);
