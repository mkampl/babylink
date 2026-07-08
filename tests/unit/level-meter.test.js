// Deterministic, input-free verification of the baby-card level meter.
//
// The real meter reads an AnalyserNode ~10×/s in a browser. We can't run Web
// Audio here, but the *dynamics* that caused the two field bugs — latency and
// flicker — live entirely in LevelMeter, which is a pure function of
// (peak, thresholds, timestamp). So we drive it with synthetic signals and
// assert on measured milliseconds and transition counts. No mic, no browser,
// no human making noise: fully reproducible.

const LevelMeter = require('../../public/js/level-meter');

const FRAME_MS = 100; // matches the 100 ms setInterval read cadence
const YELLOW = 60;
const RED = 130;

// Run a signal (array of raw peaks, one per 100 ms frame) through a meter and
// record the emitted level/volume at each frame with its timestamp.
function simulate(meter, peaks, opts = {}) {
  const yellow = opts.yellow ?? YELLOW;
  const red = opts.red ?? RED;
  const out = [];
  let t = 0;
  for (const raw of peaks) {
    const { level, volume } = meter.push(raw, yellow, red, t);
    out.push({ t, raw, level, volume });
    t += FRAME_MS;
  }
  return out;
}

function countTransitions(frames) {
  let n = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].level !== frames[i - 1].level) n++;
  }
  return n;
}

// First timestamp at which the meter reaches (or passes) a target rank.
function timeToLevel(frames, target) {
  const rank = { GREEN: 0, YELLOW: 1, RED: 2 };
  const hit = frames.find((f) => rank[f.level] >= rank[target]);
  return hit ? hit.t : Infinity;
}

// Deterministic pseudo-random (seeded LCG) so "noisy" signals are identical
// on every run — no Math.random, no flaky tests.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

// ---------------------------------------------------------------------------
// Root-cause baseline: model the OLD approach (raw threshold compare on a
// signal that was itself smoothed by AnalyserNode.smoothingTimeConstant=0.8).
// This documents, in numbers, WHY the meter lagged ~1s and WHY it flickered.
// ---------------------------------------------------------------------------
describe('baseline (old behaviour) — documents the bugs', () => {
  // AnalyserNode smoothing is an exponential filter: env = tau*env+(1-tau)*raw.
  function oldSmoothing(peaks, tau = 0.8) {
    let env = 0;
    return peaks.map((raw) => (env = tau * env + (1 - tau) * raw));
  }
  function classify(v) {
    if (v > RED) return 'RED';
    if (v > YELLOW) return 'YELLOW';
    return 'GREEN';
  }

  it('high analyser smoothing needs ~1s to settle on a loud step', () => {
    const loud = 200;
    const step = [0, 0, 0, ...Array(30).fill(loud)]; // silence then loud
    const smoothed = oldSmoothing(step, 0.8);
    // Time for the reading to reach 90% of its final value — the meter is
    // still visibly climbing until then, which is the reported ~1s lag.
    const settleIdx = smoothed.findIndex((v, i) => i >= 3 && v >= 0.9 * loud);
    const settleMs = (settleIdx - 3) * FRAME_MS;
    expect(settleMs).toBeGreaterThanOrEqual(900); // ~1s, matches the report
  });

  it('raw threshold compare with no hysteresis flickers on near-threshold noise', () => {
    const rnd = lcg(42);
    // Signal hovering right at YELLOW (60) — the classic pendling case.
    const noisy = Array.from({ length: 60 }, () => 60 + (rnd() * 30 - 15));
    let prev = 'GREEN';
    let flips = 0;
    for (const v of noisy) {
      const lvl = classify(v);
      if (lvl !== prev) flips++;
      prev = lvl;
    }
    // Dozens of flips across 60 frames — the visible green/yellow pendling.
    expect(flips).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// The fix.
// ---------------------------------------------------------------------------
describe('LevelMeter — latency (fast attack)', () => {
  it('reaches RED within 300ms of a loud step (was ~1s)', () => {
    const meter = new LevelMeter();
    const step = [0, 0, 0, ...Array(30).fill(200)];
    const frames = simulate(meter, step);
    const startLoud = 3 * FRAME_MS;
    const latency = timeToLevel(frames, 'RED') - startLoud;
    expect(latency).toBeLessThanOrEqual(300);
  });

  it('shows YELLOW almost immediately on a moderate step', () => {
    const meter = new LevelMeter();
    const step = [0, 0, ...Array(20).fill(90)]; // between yellow and red
    const frames = simulate(meter, step);
    const latency = timeToLevel(frames, 'YELLOW') - 2 * FRAME_MS;
    expect(latency).toBeLessThanOrEqual(200);
    // ...and does NOT overshoot to RED on a merely-moderate signal.
    expect(frames.some((f) => f.level === 'RED')).toBe(false);
  });
});

describe('LevelMeter — flicker (hysteresis + hold + slow release)', () => {
  it('produces few transitions on noise hovering at the YELLOW threshold', () => {
    const meter = new LevelMeter();
    const rnd = lcg(42);
    const noisy = Array.from({ length: 60 }, () => 60 + (rnd() * 30 - 15));
    const frames = simulate(meter, noisy);
    // Old naive path flipped >10×; hysteresis+hold keeps it calm.
    expect(countTransitions(frames)).toBeLessThanOrEqual(3);
  });

  it('produces few transitions on noise hovering at the RED threshold', () => {
    const meter = new LevelMeter();
    const rnd = lcg(7);
    const noisy = Array.from({ length: 60 }, () => 130 + (rnd() * 40 - 20));
    const frames = simulate(meter, noisy);
    expect(countTransitions(frames)).toBeLessThanOrEqual(4);
  });

  it('a single-frame spike does not latch RED forever but rising is honoured', () => {
    const meter = new LevelMeter();
    const signal = [0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const frames = simulate(meter, signal);
    // It should react to the spike (rise is immediate)...
    expect(frames.some((f) => f.level === 'RED' || f.level === 'YELLOW')).toBe(true);
    // ...but return to GREEN once silence persists (hold then release).
    expect(frames[frames.length - 1].level).toBe('GREEN');
  });
});

describe('LevelMeter — correctness & recovery', () => {
  it('rises to RED on sustained loud then falls back to GREEN on silence', () => {
    const meter = new LevelMeter();
    const signal = [...Array(15).fill(200), ...Array(25).fill(0)];
    const frames = simulate(meter, signal);
    expect(frames.some((f) => f.level === 'RED')).toBe(true);
    expect(frames[frames.length - 1].level).toBe('GREEN');
  });

  it('honours the minimum hold: does not drop level within minHoldMs', () => {
    const meter = new LevelMeter({ minHoldMs: 450 });
    // Get to RED, then go instantly silent.
    const frames = simulate(meter, [200, 200, 200, ...Array(10).fill(0)]);
    const enteredRedAt = frames.find((f) => f.level === 'RED').t;
    // Within the hold window after entering RED, it must not have dropped.
    const duringHold = frames.filter(
      (f) => f.t > enteredRedAt && f.t < enteredRedAt + 450
    );
    expect(duringHold.every((f) => f.level === 'RED')).toBe(true);
  });

  it('hysteresis: a level entered is not lost on a tiny dip below enter', () => {
    const meter = new LevelMeter();
    // Climb into YELLOW then dip just below the enter threshold but above exit.
    const signal = [90, 90, 90, 90, 55, 55, 55]; // 55 is < YELLOW(60) but > exit(43.2)
    const frames = simulate(meter, signal);
    // After settling in YELLOW, small dips below 60 keep it YELLOW (no flTo GREEN).
    const tail = frames.slice(4);
    expect(tail.every((f) => f.level === 'YELLOW')).toBe(true);
  });

  it('reset() returns to silence', () => {
    const meter = new LevelMeter();
    simulate(meter, Array(10).fill(200));
    meter.reset();
    const r = meter.push(0, YELLOW, RED, 0);
    expect(r.level).toBe('GREEN');
    expect(r.volume).toBe(0);
  });
});
