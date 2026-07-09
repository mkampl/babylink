// Deterministic tests for the per-baby audio-path health/arbitration. No
// browser, no audio — feed synthetic energy/frame events with injected time.
// The critical case is the "wedged" esp_peer tunnel: track live but silent.

const AudioHealth = require('../../public/js/audio-health');

const LOUD = 200;   // analyser peak that counts as sound
const QUIET = 3;    // below energyThresh

describe('AudioHealth — arbitration (never go silent)', () => {
  it('WebRTC delivering → mute PCM, status "webrtc"', () => {
    const h = new AudioHealth();
    let t = 0;
    for (let i = 0; i < 10; i++) { h.markWebrtcLevel(t, LOUD); h.markPcmFrame(t); h.markPcmLevel(t, LOUD); t += 100; }
    expect(h.shouldPlayPcm(t)).toBe(false);   // WebRTC owns the speaker
    expect(h.status(t)).toBe('webrtc');
  });

  it('WEDGED tunnel (WebRTC live then silent while PCM has sound) → PCM plays, status "backup"', () => {
    const h = new AudioHealth();
    let t = 0;
    // WebRTC was delivering, then goes silent (wedged) — but PCM keeps
    // carrying real sound (a crying baby) every frame.
    for (let i = 0; i < 5; i++) { h.markWebrtcLevel(t, LOUD); h.markPcmFrame(t); h.markPcmLevel(t, LOUD); t += 100; }
    // WebRTC stops producing energy; PCM still loud.
    for (let i = 0; i < 20; i++) { h.markPcmFrame(t); h.markPcmLevel(t, LOUD); t += 100; }
    expect(h.shouldPlayPcm(t)).toBe(true);    // NEVER SILENT — backup takes over
    expect(h.status(t)).toBe('backup');
  });

  it('pure PCM (WebRTC never connects) with sound → PCM plays, status "backup"', () => {
    const h = new AudioHealth();
    let t = 0;
    for (let i = 0; i < 15; i++) { h.markPcmFrame(t); h.markPcmLevel(t, LOUD); t += 100; }
    expect(h.shouldPlayPcm(t)).toBe(true);
    expect(h.status(t)).toBe('backup');
  });

  it('quiet room, device alive → PCM routed (harmless) but status "quiet"', () => {
    const h = new AudioHealth();
    let t = 0;
    for (let i = 0; i < 15; i++) { h.markPcmFrame(t); h.markPcmLevel(t, QUIET); t += 100; }
    expect(h.shouldPlayPcm(t)).toBe(true);    // routing silence is harmless
    expect(h.status(t)).toBe('quiet');
  });
});

describe('AudioHealth — stall detection (honest "no audio")', () => {
  it('no PCM frames for stallMs and WebRTC not delivering → status "stalled"', () => {
    const h = new AudioHealth({ stallMs: 8000 });
    let t = 0;
    for (let i = 0; i < 10; i++) { h.markPcmFrame(t); h.markPcmLevel(t, QUIET); t += 100; }
    // Device stops sending entirely.
    t += 9000; // 9 s of nothing
    expect(h.status(t)).toBe('stalled');
    expect(h.shouldPlayPcm(t)).toBe(true); // (nothing to play, but not forced-muted)
  });

  it('a wedged-silent WebRTC track does NOT read as healthy — stall still fires', () => {
    const h = new AudioHealth({ stallMs: 8000 });
    let t = 0;
    // WebRTC "live" earlier but produced its last energy long ago; PCM also
    // stopped. The old track-state check would have said "live=connected".
    h.markWebrtcLevel(0, LOUD);
    h.markPcmFrame(0);
    t = 9000;
    expect(h.status(t)).toBe('stalled');
  });

  it('recovers to quiet/backup once frames resume', () => {
    const h = new AudioHealth({ stallMs: 8000 });
    let t = 0;
    h.markPcmFrame(0);
    t = 9000;
    expect(h.status(t)).toBe('stalled');
    h.markPcmFrame(t); h.markPcmLevel(t, LOUD);
    expect(h.status(t)).toBe('backup');
  });
});
