// Guards against the red/green flicker caused by the WebRTC meter and the PCM
// meter both driving the badge at once. They must partition perfectly: for any
// given track state, exactly ONE path owns the meter. We assert that
// MultiStreamManager._audioLive is the exact complement of the predicate
// ESP32AudioHandler._webrtcActive uses (both read the same MediaStreamTrack).

const MultiStreamManager = require('../../public/js/multi-stream-manager');

// Minimal fake of a MediaStream exposing one audio track with a given state.
function fakeStream(track) {
  return { getAudioTracks: () => (track ? [track] : []) };
}
const TRACK_STATES = [
  { muted: false, readyState: 'live' },   // audio flowing
  { muted: true, readyState: 'live' },    // present but silent
  { muted: false, readyState: 'ended' },  // gone
  { muted: true, readyState: 'ended' },
];

// The predicate both modules use to decide "is WebRTC audio live?".
// (ESP32AudioHandler._webrtcActive is the same check; it lives in a
// DOM-coupled module, so we replicate the pure predicate here.)
function isWebrtcLive(stream) {
  if (!stream) return false;
  const t = stream.getAudioTracks();
  return t.length > 0 && !t[0].muted && t[0].readyState === 'live';
}

describe('meter arbitration — WebRTC vs PCM', () => {
  const mgr = new MultiStreamManager({}, {});

  it('_audioLive matches the shared "webrtc live" predicate for every track state', () => {
    for (const st of TRACK_STATES) {
      mgr.audioStreams.set('p', fakeStream(st));
      expect(mgr._audioLive('p')).toBe(isWebrtcLive(fakeStream(st)));
    }
  });

  it('exactly one path drives the meter: WebRTC drives iff PCM yields', () => {
    for (const st of TRACK_STATES) {
      const stream = fakeStream(st);
      mgr.audioStreams.set('p', stream);
      const webrtcDrives = mgr._audioLive('p');       // multi-stream pushes?
      const pcmYields = isWebrtcLive(stream);         // esp32 returns early?
      // esp32 drives when it does NOT yield. So drivers are complementary.
      const pcmDrives = !pcmYields;
      expect(webrtcDrives === !pcmDrives).toBe(true); // never both, never neither
    }
  });

  it('no stream at all → WebRTC yields (PCM owns the meter)', () => {
    mgr.audioStreams.delete('gone');
    expect(mgr._audioLive('gone')).toBe(false);
  });

  it('a missing audio track → not live', () => {
    mgr.audioStreams.set('empty', fakeStream(null));
    expect(mgr._audioLive('empty')).toBe(false);
  });
});
