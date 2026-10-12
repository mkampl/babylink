// Parent-side roster of babies that are present vs. ones that dropped out.
//
// A baby that leaves keeps its card (shown as disconnected) and keeps the
// alarm going — even while other babies are still connected — until it
// returns or the parent dismisses it. ESP32 devices return under the same
// id; phone/browser babies return under a new socket id but the same name,
// which replaces the stale card.
//
// Pure bookkeeping (no DOM) so it can be unit-tested.

(function (global) {
  'use strict';

  class BabyRoster {
    constructor() {
      this.names = new Map(); // id -> name (every baby with a card)
      this.gone = new Set();  // ids whose baby has left
    }

    /**
     * A baby is (back) in the room. Returns { revived, replaced }: revived if
     * this id had left and is back; replaced = ids of stale cards (same name,
     * different id) the caller should tear down.
     */
    joined(id, name) {
      const revived = this.gone.delete(id);
      const replaced = [];
      if (!revived && name) {
        for (const g of this.gone) {
          if (this.names.get(g) === name) replaced.push(g);
        }
        replaced.forEach((g) => this.forget(g));
      }
      this.names.set(id, name || this.names.get(id) || '');
      return { revived, replaced };
    }

    left(id) {
      if (this.names.has(id)) this.gone.add(id);
    }

    isGone(id) { return this.gone.has(id); }

    forget(id) {
      this.gone.delete(id);
      this.names.delete(id);
    }

    shouldAlarm() { return this.gone.size > 0; }

    goneNames() {
      return Array.from(this.gone).map((id) => this.names.get(id)).filter(Boolean);
    }

    clear() {
      this.names.clear();
      this.gone.clear();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BabyRoster;
  } else {
    global.BabyRoster = BabyRoster;
  }
})(typeof window !== 'undefined' ? window : globalThis);
