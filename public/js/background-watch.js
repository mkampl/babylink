// Notices when the monitor page comes back after a long time in the
// background. Browsers throttle timers in hidden tabs (Chrome heavily after
// ~5 minutes unless the page is audibly playing), so while hidden the
// parent's meters, crying detection and disconnect alarm may have stalled.
// The page can't reliably prevent that, so it says so.

(function (global) {
  'use strict';

  class BackgroundWatch {
    constructor(opts) {
      opts = opts || {};
      this.warnAfterMs = opts.warnAfterMs != null ? opts.warnAfterMs : 60_000;
      this.hiddenAt = null;
    }

    hidden(now) {
      if (this.hiddenAt == null) this.hiddenAt = now;
    }

    /** Returns true if the parent should be warned about the absence. */
    visible(now) {
      const since = this.hiddenAt;
      this.hiddenAt = null;
      return since != null && now - since >= this.warnAfterMs;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BackgroundWatch;
  } else {
    global.BackgroundWatch = BackgroundWatch;
  }
})(typeof window !== 'undefined' ? window : globalThis);
