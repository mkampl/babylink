// Parent-side sleep tracker. Listens to per-baby volume observations
// fed in by multi-baby-ui (which already collects them for the level
// meter), classifies into GREEN/YELLOW/RED, accumulates per-second
// time at each level in 15 s slots, persists to localStorage, and
// exposes aggregated views for the two-tier sleep timeline:
//
//   • detail bar — last 15 minutes at 15 s slot resolution (60 slots)
//   • history bar — last 24 h at 1 min slot resolution (1440 slots)
//
// Storage is uniform 15 s slots internally; the aggregator picks
// granularity per render zone so we never lose detail on disk.
//
// Thresholds derive from the per-baby sensitivity slider so the user
// tunes them live — no firmware reflash, no broken old data.
class SleepTracker {
  constructor(babyId, roomId, options = {}) {
    this.babyId = babyId;
    this.roomId = roomId;

    this.detailSlotMs    = 15 * 1000;            // 15 s
    this.detailWindowMs  = 15 * 60 * 1000;       // 15 min
    this.historySlotMs   = 60 * 1000;            // 1 min
    this.totalRetentionMs = 24 * 3600 * 1000;    // 24 h

    // sensitivity 0.5 - 3.0 (1.0 = default). Maps inversely onto the
    // volume thresholds the level meter uses, so the slider does
    // double-duty: louder thresholds for the audible meter AND for
    // the sleep classifier.
    this.sensitivity = options.sensitivity || 1.0;
    this._recomputeThresholds();

    // Map<slotIdx, { g, y, r }>  — seconds spent at each level in slot
    this.slots = new Map();

    this.currentVolume = null;
    this._lastSaveMs = 0;
    this._dirty = false;
    this._lastTickIdx = null;

    this.load();
    this._tickInterval = setInterval(() => this.tick(), 1000);
  }

  setSensitivity(sensitivity) {
    this.sensitivity = sensitivity;
    this._recomputeThresholds();
    this._dirty = true;
  }

  _recomputeThresholds() {
    // Default thresholds match the legacy esp32-audio-handler /
    // multi-stream-manager peak values (volume is 0-255 from
    // AnalyserNode.getByteFrequencyData peak).
    const baseYellow = 60;
    const baseRed    = 130;
    this.thresholds = {
      yellow: Math.max(1, baseYellow / this.sensitivity),
      red:    Math.max(1, baseRed    / this.sensitivity),
    };
  }

  // Called by the level-meter pipeline whenever it has a new volume
  // sample. We don't store the raw sample; tick() at 1 Hz reads
  // whatever the latest one was.
  observe(volume) {
    this.currentVolume = volume;
  }

  tick() {
    if (this.currentVolume === null) return;
    const now = Date.now();
    const level = this._classify(this.currentVolume);
    const slotIdx = Math.floor(now / this.detailSlotMs);
    const slot = this.slots.get(slotIdx) || { g: 0, y: 0, r: 0 };
    slot[level] += 1;
    this.slots.set(slotIdx, slot);
    this._lastTickIdx = slotIdx;
    this._dirty = true;
    if (now - this._lastSaveMs >= 30000) {
      this._prune();
      this._save();
    }
  }

  _classify(volume) {
    if (volume >= this.thresholds.red)    return 'r';
    if (volume >= this.thresholds.yellow) return 'y';
    return 'g';
  }

  _prune() {
    const cutoffIdx = Math.floor((Date.now() - this.totalRetentionMs) / this.detailSlotMs);
    for (const idx of this.slots.keys()) {
      if (idx < cutoffIdx) this.slots.delete(idx);
    }
  }

  _save() {
    if (!this._dirty) return;
    try {
      localStorage.setItem(this._key(), JSON.stringify({
        slots: Array.from(this.slots.entries()),
        sensitivity: this.sensitivity,
        savedAt: Date.now(),
      }));
      this._lastSaveMs = Date.now();
      this._dirty = false;
    } catch (e) {
      console.warn('[sleep-tracker] save failed:', e.message);
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(this._key());
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.slots)) this.slots = new Map(data.slots);
      if (typeof data.sensitivity === 'number') {
        this.sensitivity = data.sensitivity;
        this._recomputeThresholds();
      }
      this._prune();
    } catch (e) {
      console.warn('[sleep-tracker] load failed:', e.message);
    }
  }

  _key() {
    return `babylink-sleep-${this.roomId}-${this.babyId}`;
  }

  // Aggregate the internal 15 s slot store into display slots of the
  // requested size, covering the requested window. A returned slot's
  // `hasData=false` means we have no observation for that span
  // (parent was offline / laptop was asleep) → renderer paints grey.
  getSlots(windowMs, slotSizeMs) {
    const now = Date.now();
    const startTime = now - windowMs;
    const out = [];
    for (let t = startTime; t < now; t += slotSizeMs) {
      let g = 0, y = 0, r = 0;
      const fromIdx = Math.floor(t / this.detailSlotMs);
      const toIdx   = Math.ceil((t + slotSizeMs) / this.detailSlotMs);
      for (let i = fromIdx; i < toIdx; i++) {
        const s = this.slots.get(i);
        if (!s) continue;
        g += s.g; y += s.y; r += s.r;
      }
      const observed = g + y + r;
      out.push({
        startMs: t,
        endMs: t + slotSizeMs,
        // "highest colour wins" for the visual stripe; precise seconds
        // are in g/y/r below if the caller wants more detail.
        dominant: r > 0 ? 'r' : y > 0 ? 'y' : g > 0 ? 'g' : null,
        g, y, r,
        hasData: observed > 0,
      });
    }
    return out;
  }

  // Total seconds at each level over the given window. The renderer
  // turns this into the "8 h 23 min quiet, 4 wake events" line.
  getSummary(windowMs) {
    const cutoffIdx = Math.floor((Date.now() - windowMs) / this.detailSlotMs);
    let g = 0, y = 0, r = 0;
    for (const [idx, slot] of this.slots) {
      if (idx < cutoffIdx) continue;
      g += slot.g; y += slot.y; r += slot.r;
    }
    return { greenSecs: g, yellowSecs: y, redSecs: r };
  }

  // Count transitions from GREEN-dominant → non-GREEN-dominant in
  // 1-min aggregated slots — matches what the legacy implementation
  // called "wake events".
  getWakeCount(windowMs) {
    const slots = this.getSlots(windowMs, 60 * 1000);
    let count = 0;
    let prev = null;
    for (const s of slots) {
      if (!s.hasData) { prev = null; continue; }
      if (prev === 'g' && s.dominant !== 'g') count++;
      prev = s.dominant;
    }
    return count;
  }

  destroy() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    this._prune();
    this._save();
  }
}

if (typeof window !== 'undefined') {
  window.SleepTracker = SleepTracker;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SleepTracker;
}
