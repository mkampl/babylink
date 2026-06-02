/**
 * WebRTC baby receiver — parent-side peer for ESP32-S3 baby devices.
 *
 * Branch 4 scaffolding. This file exists so Branch 5 (ESP-side WebRTC)
 * has a known shape on the browser to talk to. The signaling path
 * (`signal` Socket.IO event, server-bridged to/from ESP WS) is already
 * live; this class wires that path into an RTCPeerConnection per ESP32
 * baby. The actual ontrack → <audio> plumbing and the offer/answer
 * orchestration land with Branch 5/6 when there's an ESP firmware to
 * negotiate with.
 *
 * Usage (will land in multi-baby-ui.js once the ESP can answer):
 *   const receiver = new WebRTCBabyReceiver(socket, multiBabyUI);
 *   // when a participant-joined event carries deviceType === 'esp32-s3':
 *   receiver.attach(participant.socketId);
 *   // on participant-left:
 *   receiver.detach(participant.socketId);
 */
// Shared set of espIds currently receiving audio via WebRTC. Lets the
// legacy WSS-PCM path (ESP32AudioHandler) know to suppress its own
// playback for the same baby — otherwise both streams overlap with a
// small phase offset and the parent hears a "hall" / echo effect.
const webrtcActiveBabies = new Set();

class WebRTCBabyReceiver {
  constructor(socket, multiBabyUI, rtcConfig = null) {
    this.socket = socket;
    this.multiBabyUI = multiBabyUI;
    // Default rtcConfig: STUN-only fallback. Pull TURN creds from
    // /api/config/webrtc when wiring up properly (Branch 5).
    this.rtcConfig = rtcConfig || {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    };
    this.peers = new Map(); // espId → RTCPeerConnection

    // The server bridges ESP↔browser via the existing 'signal' event.
    // We tap it here so multiple receivers can coexist (one per ESP).
    socket.on('signal', (data) => this._onSignal(data));
  }

  /**
   * Begin a peer connection with the given ESP32 baby. Sends an offer
   * once Branch 5 implementation has an ESP firmware to negotiate with;
   * for now it just sets up the local-side state.
   */
  attach(espId) {
    if (this.peers.has(espId)) return;
    const pc = new RTCPeerConnection(this.rtcConfig);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.socket.emit('signal', {
        to: espId,
        ice: ev.candidate,
      });
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams && ev.streams[0];
      if (!stream) return;
      console.log('[webrtc-receiver] ontrack from', espId, stream);
      // Minimal playback wiring — full baby-card meter integration
      // lands in 5.2 mc4. For mc3 we just need to hear it.
      let audioEl = document.getElementById(`webrtc-audio-${espId}`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `webrtc-audio-${espId}`;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = stream;
      audioEl.play().catch(err => {
        console.warn('[webrtc-receiver] play failed:', err.message);
      });
      // Tell ESP32AudioHandler to stop playing the WSS-PCM stream for
      // this baby — otherwise both paths play simultaneously with a
      // small phase offset and the parent hears an echo.
      webrtcActiveBabies.add(espId);
    };

    pc.onconnectionstatechange = () => {
      console.debug('[webrtc-receiver]', espId, 'state =', pc.connectionState);
      if (pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed') {
        webrtcActiveBabies.delete(espId);
      }
    };

    this.peers.set(espId, pc);
    // The ESP is the offerer (esp_peer ROLE_CONTROLLING). It can't know
    // a parent is ready until we tell it, so kick off here. The ESP
    // wraps incoming requestOffer into esp_peer_new_connection().
    this.socket.emit('signal', { to: espId, requestOffer: true });
  }

  /**
   * Tear down a peer connection (e.g. on participant-left).
   */
  detach(espId) {
    const pc = this.peers.get(espId);
    if (!pc) return;
    pc.close();
    this.peers.delete(espId);
    webrtcActiveBabies.delete(espId);
    const audioEl = document.getElementById(`webrtc-audio-${espId}`);
    if (audioEl) audioEl.remove();
  }

  /**
   * Handle a signal message from the server. The 'signal' event carries
   * fromSocketId — when it starts with 'esp32_' the sender is an ESP32
   * peer routed through our WS bridge. Browser↔browser signaling for
   * the PWA-baby path is handled elsewhere (existing code in app.js).
   */
  async _onSignal(data) {
    const from = data.fromSocketId;
    if (!from || !from.startsWith('esp32_')) return; // not ours
    const pc = this.peers.get(from);
    if (!pc) {
      // Either we haven't attach()ed yet (race during participant-joined)
      // or this signal is for a different receiver instance. Ignore.
      return;
    }
    try {
      if (data.offer) {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.offer });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('signal', { to: from, answer: answer.sdp });
      } else if (data.answer) {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.answer });
      } else if (data.ice) {
        await pc.addIceCandidate(data.ice);
      }
    } catch (err) {
      console.error('[webrtc-receiver] signal error', err);
    }
  }
}

// Make available without a module loader, matching the rest of public/js.
// Expose webrtcActiveBabies on window so ESP32AudioHandler can check it
// (cross-file globals are how the rest of public/js coordinates).
if (typeof window !== 'undefined') {
  window.WebRTCBabyReceiver = WebRTCBabyReceiver;
  window._webrtcActiveBabies = webrtcActiveBabies;
}
