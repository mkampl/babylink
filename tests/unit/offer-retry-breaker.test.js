// The offer-retry breaker (_retryOffer) is the single path both the
// connection-failed handler and the malformed-SDP catch use to tear down a
// dead peer and re-request an offer, capped at 3 tries so esp_peer's flaky
// reconnects can't loop forever. This locks the behaviour after the dedup.

const MultiStreamManager = require('../../public/js/multi-stream-manager');

function makeManager() {
  const emitted = [];
  const socket = { emit: (ev, payload) => emitted.push({ ev, payload }) };
  const mgr = new MultiStreamManager(socket, {});
  mgr._emitted = emitted;
  return mgr;
}

function fakePeer() {
  return { closed: false, close() { this.closed = true; } };
}

describe('_retryOffer breaker', () => {
  it('fires a requestOffer and closes+removes the peer', () => {
    const mgr = makeManager();
    const peer = fakePeer();
    mgr.peerConnections.set('p', peer);

    expect(mgr._retryOffer('p')).toBe(true);
    expect(peer.closed).toBe(true);
    expect(mgr.peerConnections.has('p')).toBe(false);
    expect(mgr._emitted).toEqual([{ ev: 'signal', payload: { requestOffer: true, to: 'p' } }]);
    expect(mgr.offerRetries.get('p')).toBe(1);
  });

  it('gives up after 3 retries (breaker trips)', () => {
    const mgr = makeManager();
    let fired = 0;
    for (let i = 0; i < 5; i++) {
      mgr.peerConnections.set('p', fakePeer());
      if (mgr._retryOffer('p')) fired++;
    }
    expect(fired).toBe(3);                 // only 3 retries ever fire
    expect(mgr._retryOffer('p')).toBe(false);
    expect(mgr._emitted.length).toBe(3);   // no further requestOffer emits
  });

  it('still fires when the peer is already gone (failed-state path)', () => {
    const mgr = makeManager();
    // no peer registered for 'p'
    expect(mgr._retryOffer('p')).toBe(true);
    expect(mgr._emitted).toEqual([{ ev: 'signal', payload: { requestOffer: true, to: 'p' } }]);
  });

  it('a successful connection resets the breaker (via offerRetries.delete)', () => {
    const mgr = makeManager();
    mgr.peerConnections.set('p', fakePeer());
    mgr._retryOffer('p');
    mgr.offerRetries.delete('p'); // what reaching 'connected' does
    mgr.peerConnections.set('p', fakePeer());
    expect(mgr._retryOffer('p')).toBe(true);
    expect(mgr.offerRetries.get('p')).toBe(1); // counter restarted
  });
});

// Chrome fires ontrack as soon as the remote offer is applied — long before
// ICE/DTLS succeed. Resetting the breaker there meant a tunnel that always
// failed its handshake re-armed the breaker on every attempt: an endless
// requestOffer storm against the ESP (every ~3.5 s after a parent reload),
// each new request aborting the device's handshake in progress.
describe('breaker reset happens on a real connection, not on ontrack', () => {
  class FakePC {
    constructor() { this.connectionState = 'new'; FakePC.last = this; }
    close() { this.connectionState = 'closed'; }
  }
  beforeEach(() => { globalThis.RTCPeerConnection = FakePC; });
  afterEach(() => { delete globalThis.RTCPeerConnection; });

  function attempt(mgr, finalState) {
    const pc = mgr.createPeerConnection('esp', { socketId: 'esp', role: 'baby' });
    mgr.createAudioElement = () => {};
    pc.ontrack({ streams: [{ id: 's' }] });           // offer applied
    pc.connectionState = finalState;
    pc.onconnectionstatechange();
  }

  it('handshakes that keep failing trip the breaker after 3 retries', () => {
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) attempt(mgr, 'failed');
    const requests = mgr._emitted.filter((e) => e.payload && e.payload.requestOffer);
    expect(requests.length).toBe(3);
  });

  it('reaching connected re-arms the breaker for a later failure', () => {
    const mgr = makeManager();
    attempt(mgr, 'failed');
    attempt(mgr, 'failed');
    attempt(mgr, 'connected');
    expect(mgr.offerRetries.has('esp')).toBe(false);
  });
});
