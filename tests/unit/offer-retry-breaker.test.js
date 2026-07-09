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

  it('a successful stream resets the breaker (via offerRetries.delete)', () => {
    const mgr = makeManager();
    mgr.peerConnections.set('p', fakePeer());
    mgr._retryOffer('p');
    mgr.offerRetries.delete('p'); // what ontrack does on success
    mgr.peerConnections.set('p', fakePeer());
    expect(mgr._retryOffer('p')).toBe(true);
    expect(mgr.offerRetries.get('p')).toBe(1); // counter restarted
  });
});
