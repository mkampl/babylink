// Pure tests for the AudioWorklet jitter buffer + resampler (no browser).
const { PcmRing } = require('../../public/js/pcm-playout-processor');

function fill(n, fn) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(i); return a; }

describe('PcmRing — resampling', () => {
  it('a constant input yields a constant output (no interpolation artifacts)', () => {
    const r = new PcmRing({ inputRate: 16000, outputRate: 48000 });
    r.enqueue(fill(1600, () => 0.5)); // 100ms of 0.5
    const out = new Float32Array(128);
    r.pull(out);
    // every produced sample should be ~0.5 (allowing the last if it hit the tail)
    for (let i = 0; i < 100; i++) expect(Math.abs(out[i] - 0.5)).toBeLessThan(1e-6);
  });

  it('passthrough when input rate == output rate (step 1)', () => {
    const r = new PcmRing({ inputRate: 48000, outputRate: 48000 });
    r.enqueue(fill(128, (i) => i / 128));
    const out = new Float32Array(128);
    r.pull(out);
    for (let i = 0; i < 127; i++) expect(out[i]).toBeCloseTo(i / 128, 5);
  });

  it('consumes input at the resample ratio (16k->48k ≈ 1/3)', () => {
    const r = new PcmRing({ inputRate: 16000, outputRate: 48000 });
    r.enqueue(fill(16000, () => 0.1)); // 1s of input
    const out = new Float32Array(48000);
    r.pull(out); // pull 1s of output
    // Should have consumed ~all 16000 input samples (±1 for fractional tail).
    expect(r.available).toBeLessThanOrEqual(1);
    expect(r.underruns).toBe(0);
  });
});

describe('PcmRing — underrun (never wedges, emits silence)', () => {
  it('empty ring outputs silence and counts underruns', () => {
    const r = new PcmRing({ inputRate: 16000, outputRate: 48000 });
    const out = new Float32Array(128).fill(9);
    r.pull(out);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
    expect(r.underruns).toBe(128);
  });

  it('resumes cleanly after an underrun when fresh audio arrives', () => {
    const r = new PcmRing({ inputRate: 16000, outputRate: 48000 });
    r.pull(new Float32Array(128));          // starve
    r.enqueue(fill(1600, () => 0.3));
    const out = new Float32Array(128);
    r.pull(out);
    expect(out[0]).toBeCloseTo(0.3, 5);
  });
});

describe('PcmRing — overrun (caps latency)', () => {
  it('drops oldest audio so buffered latency stays under the cap', () => {
    const r = new PcmRing({ inputRate: 16000, outputRate: 48000, maxMs: 400 });
    // Enqueue 2s of audio (way over the 400ms cap) without pulling.
    for (let k = 0; k < 20; k++) r.enqueue(fill(1600, () => 0.2)); // 20 × 100ms
    expect(r.available).toBeLessThanOrEqual(r.maxSamples);
    expect(r.dropped).toBeGreaterThan(0);
  });
});
