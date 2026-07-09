// AudioWorklet playout for the ESP raw-PCM stream.
//
// The old path scheduled one AudioBufferSourceNode per ~64ms chunk with
// hand-rolled start-time math (nextStartTime + lead, re-anchor on drift). Under
// network jitter that could drift, glitch, or overlap two copies of a chunk
// (the "hall"/reverb artifact). This replaces it with the professional shape:
// playout runs on the audio render thread, pulling from a jitter buffer with a
// fractional resampler (the ESP sends 16 kHz; the AudioContext runs at 48/44.1
// kHz), with explicit underrun (emit silence) and overrun (drop oldest to cap
// latency) handling instead of fragile timestamps.
//
// Frames arrive from the main thread via port.postMessage (no SharedArrayBuffer
// needed — the port message handler and process() both run on the audio thread,
// so the queue needs no locks).
//
// PcmRing (the jitter buffer + resampler) is pure and exported for Node so it
// can be unit-tested with no browser — see tests/unit/pcm-ring.test.js.

class PcmRing {
  constructor(opts) {
    opts = opts || {};
    const inRate = opts.inputRate || 16000;
    const outRate = opts.outputRate || 48000;
    this.step = inRate / outRate;                 // input samples per output sample
    this.maxSamples = Math.floor(inRate * ((opts.maxMs || 400) / 1000)); // latency cap
    this.chunks = [];   // queue of Float32Array (input-rate samples)
    this.headPos = 0;   // read index within chunks[0]
    this.frac = 0;      // fractional read position for interpolation
    this.total = 0;     // total input samples currently buffered
    this.underruns = 0; // output samples emitted as silence (starvation)
    this.dropped = 0;   // input samples dropped to cap latency (overrun)
  }

  enqueue(samples) {
    if (!samples || samples.length === 0) return;
    this.chunks.push(samples);
    this.total += samples.length;
    // Overrun: a network burst must not grow unbounded latency. Drop from the
    // front (oldest audio) down to the cap.
    while (this.total - this.headPos > this.maxSamples && this.chunks.length > 1) {
      const d = this.chunks.shift();
      this.total -= d.length;
      this.dropped += (d.length - this.headPos);
      this.headPos = 0;
      this.frac = 0;
    }
  }

  get available() { return this.total - this.headPos; }

  // Sample `offset` input-samples ahead of the read head, or null if not buffered.
  _sampleAt(offset) {
    let idx = this.headPos + offset;
    for (let c = 0; c < this.chunks.length; c++) {
      const ch = this.chunks[c];
      if (idx < ch.length) return ch[idx];
      idx -= ch.length;
    }
    return null;
  }

  // Consume one input sample from the head.
  _advance() {
    this.headPos++;
    while (this.chunks.length && this.headPos >= this.chunks[0].length) {
      const d = this.chunks.shift();
      this.headPos -= d.length;
      this.total -= d.length;
    }
    if (this.chunks.length === 0) { this.headPos = 0; this.total = 0; }
  }

  // Fill `out` (Float32Array, length = render quantum) at the output rate with
  // linear-interpolated resampling. Emits silence on underrun.
  pull(out) {
    for (let i = 0; i < out.length; i++) {
      const cur = this._sampleAt(0);
      if (cur === null) { out[i] = 0; this.underruns++; continue; }
      const nxtRaw = this._sampleAt(1);
      const nxt = nxtRaw === null ? cur : nxtRaw;
      out[i] = cur + (nxt - cur) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; this._advance(); }
    }
    return out;
  }
}

// The processor itself only exists in the AudioWorklet scope (where
// AudioWorkletProcessor is defined). Guarded so this file can be required in
// Node to unit-test PcmRing.
if (typeof AudioWorkletProcessor !== 'undefined') {
  class PcmPlayoutProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const po = (options && options.processorOptions) || {};
      // `sampleRate` is a global in the AudioWorklet scope = the context rate.
      this.ring = new PcmRing({ inputRate: po.inputRate || 16000, outputRate: sampleRate });
      this.port.onmessage = (e) => {
        if (e.data && e.data.length) this.ring.enqueue(e.data);
      };
    }
    process(_inputs, outputs) {
      const ch = outputs[0][0];
      if (ch) this.ring.pull(ch);
      return true; // keep alive
    }
  }
  registerProcessor('pcm-playout', PcmPlayoutProcessor);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PcmRing };
}
