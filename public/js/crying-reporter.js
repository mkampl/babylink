// Tells the server when a baby's card turns RED (crying), so it can send the
// room's push notification. Fed from the shared level hook that every audio
// path goes through (WebRTC babies and ESP PCM babies alike): reports the
// start of a crying episode at once, then at most once per cooldown while it
// lasts. Pure and time-injectable → unit-tested.

(function (global) {
  'use strict';

  class CryingReporter {
    constructor(emit, cooldownMs) {
      this.emit = emit;
      this.cooldownMs = cooldownMs != null ? cooldownMs : 10000;
      this.state = new Map(); // babyId → { crying, lastEmit }
    }

    observe(babyId, level, now) {
      const s = this.state.get(babyId) || { crying: false, lastEmit: -Infinity };
      if (level === 'RED') {
        if (!s.crying || now - s.lastEmit > this.cooldownMs) {
          s.lastEmit = now;
          this.emit(babyId);
        }
        s.crying = true;
      } else {
        s.crying = false;
      }
      this.state.set(babyId, s);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CryingReporter;
  } else {
    global.CryingReporter = CryingReporter;
  }
})(typeof window !== 'undefined' ? window : globalThis);
