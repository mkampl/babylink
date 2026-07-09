// public/js/multi-stream-manager.js
// Manages multiple WebRTC peer connections for multi-baby monitoring

class MultiStreamManager {
  constructor(socket, config) {
    this.socket = socket;
    this.config = config;
    this.peerConnections = new Map(); // participantId → RTCPeerConnection
    this.audioStreams = new Map();    // participantId → MediaStream
    this.audioElements = new Map();   // participantId → HTMLAudioElement
    this.analysers = new Map();       // participantId → AudioAnalyser
    this.participants = new Map();    // participantId → participant info
    this.sensitivity = new Map();     // participantId → sensitivity multiplier (0.5-3.0, default 1.0)
    this.offerRetries = new Map();    // participantId → retry count (esp_peer bad-SDP retry breaker)

    this.onStreamAdded = null;
    this.onStreamRemoved = null;
    this.onAudioLevelUpdate = null;
    this.onConnectionFailed = null;
  }

  /**
   * Tear down a peer and ask the baby for a fresh offer, respecting the
   * retry breaker (max 3) that stops esp_peer's occasional malformed-SDP
   * reconnects from looping forever. Audio elements + analyser are kept so
   * the baby card survives the retry. Returns true if a retry was fired.
   */
  _retryOffer(participantId) {
    const retries = this.offerRetries.get(participantId) || 0;
    if (retries >= 3) return false; // breaker tripped — give up
    this.offerRetries.set(participantId, retries + 1);
    const peer = this.peerConnections.get(participantId);
    if (peer) {
      try { peer.close(); } catch (e) {}
      this.peerConnections.delete(participantId);
    }
    this.socket.emit('signal', { requestOffer: true, to: participantId });
    return true;
  }

  /**
   * Create a peer connection for a specific participant
   */
  createPeerConnection(participantId, participantInfo) {
    if (this.peerConnections.has(participantId)) {
      return this.peerConnections.get(participantId);
    }

    const peer = new RTCPeerConnection(this.config);
    this.peerConnections.set(participantId, peer);
    this.participants.set(participantId, participantInfo);

    // Handle ICE candidates
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          ice: event.candidate,
          to: participantId
        });
      }
    };

    // Handle incoming tracks
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.audioStreams.set(participantId, stream);
        this.createAudioElement(participantId, stream, participantInfo);
        this.offerRetries.delete(participantId);   // success — clear breaker
        if (this.onStreamAdded) {
          this.onStreamAdded(participantId, stream, participantInfo);
        }
      }
    };

    // Handle connection state changes
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === 'failed') {
        // Tear down the silently-dead peer and re-request a fresh offer.
        this._retryOffer(participantId);
        // Update status dot so the card turns red instead of showing green
        if (this.onConnectionFailed) this.onConnectionFailed(participantId);
      }
    };

    return peer;
  }

  /**
   * Create audio element for a participant's stream
   */
  createAudioElement(participantId, stream, participantInfo) {
    const audio = document.createElement('audio');
    audio.id = `audio-${participantId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    audio.volume = 1.0;
    // Start muted so the card state ("Muted") matches the audio element.
    // The auto-mute logic in MultiBabyUI will unmute when sound is detected.
    audio.muted = true;

    // Hide audio element (we'll control it via UI)
    audio.style.display = 'none';
    document.body.appendChild(audio);

    this.audioElements.set(participantId, audio);

    // Initialize audio analysis
    this.initializeAudioAnalysis(participantId, stream, participantInfo);

    return audio;
  }

  /**
   * Initialize audio analysis for voice activity detection
   */
  initializeAudioAnalysis(participantId, stream, participantInfo) {
    // Reuse pre-warmed AudioContext if available (created during user gesture),
    // otherwise create a new one and try to resume it
    const audioContext = window.__sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Clear shared ref so next participant gets its own context
    if (window.__sharedAudioCtx) window.__sharedAudioCtx = null;

    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);

    analyser.fftSize = 256;
    // Keep the analyser feed responsive; the envelope smoothing (fast attack,
    // slow release) lives in LevelMeter so the meter reacts immediately to
    // sound but doesn't flicker. High smoothing here was the ~1s meter lag.
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const analysisData = {
      audioContext,
      analyser,
      source,
      dataArray,
      meter: new LevelMeter(),
      currentLevel: 'GREEN',
      lastUpdate: Date.now()
    };

    this.analysers.set(participantId, analysisData);

    // Start monitoring audio levels
    this.monitorAudioLevel(participantId);
  }

  /**
   * Is this participant's WebRTC audio actually flowing right now? Mirrors
   * ESP32AudioHandler._webrtcActive so the WebRTC and PCM meters partition
   * cleanly: exactly one owns the badge at any instant.
   */
  _audioLive(participantId) {
    const stream = this.audioStreams.get(participantId);
    if (!stream) return false;
    const tracks = stream.getAudioTracks();
    return tracks.length > 0 && !tracks[0].muted && tracks[0].readyState === 'live';
  }

  /**
   * Monitor audio levels for a specific baby.
   * Uses setInterval instead of requestAnimationFrame so the loop keeps
   * running in background tabs (rAF is throttled/suspended when hidden).
   */
  monitorAudioLevel(participantId) {
    const analyse = () => {
      const ad = this.analysers.get(participantId);
      if (!ad) return; // removeParticipant already cleared the interval

      // Drive the badge only while WebRTC is actually DELIVERING audio (recent
      // energy) — not merely "track live". A wedged live-but-silent tunnel has
      // no energy, so the PCM path (esp32-audio-handler) owns the meter and
      // speaker instead and the parent keeps hearing/seeing the baby. Both
      // paths gate on the same shared webrtcDelivering() flag, so exactly one
      // drives the badge at any instant (no red/green flicker).
      if (typeof getAudioHealth === 'function' &&
          !getAudioHealth(participantId).webrtcDelivering(Date.now())) return;

      const { analyser, dataArray } = ad;
      analyser.getByteFrequencyData(dataArray);

      // Find peak value for sensitivity-aware detection
      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i] > peak) peak = dataArray[i];
      }

      // Feed the shared audio-health tracker with the RAW WebRTC energy every
      // frame (before any gating) so both paths agree on whether WebRTC is
      // actually delivering audio — a wedged "live but silent" tunnel produces
      // no energy here and the PCM backup takes over. See audio-health.js.
      if (typeof getAudioHealth === 'function') {
        getAudioHealth(participantId).markWebrtcLevel(Date.now(), peak);
      }

      // Get sensitivity for this participant (default 1.0 if not set)
      const sensitivity = this.sensitivity.get(participantId) || 1.0;
      const adjustedVolume = peak * sensitivity;

      // Scale thresholds at low sensitivity so RED stays reachable.
      let yellowThreshold = 100;
      let redThreshold = 180;

      if (sensitivity < 0.71) {
        yellowThreshold = 100 * sensitivity;
        redThreshold = 180 * sensitivity;
      }

      // LevelMeter applies fast-attack/slow-release smoothing + hysteresis +
      // a minimum hold, so the badge tracks sound instantly without flicker.
      const { level, volume } = ad.meter.push(
        adjustedVolume, yellowThreshold, redThreshold, Date.now()
      );

      if (this.onAudioLevelUpdate) {
        this.onAudioLevelUpdate(participantId, level, volume);
      }

      if (ad.currentLevel !== level) {
        ad.currentLevel = level;
        ad.lastUpdate = Date.now();
      }
    };

    // 100 ms ≈ 10 reads/s — responsive meter without burning CPU. setInterval
    // (not rAF) so it keeps running in hidden tabs for crying detection.
    const analysisData = this.analysers.get(participantId);
    if (analysisData) {
      analysisData.intervalId = setInterval(analyse, 100);
    }
  }

  /**
   * Handle incoming WebRTC signal (offer/answer/ICE)
   */
  async handleSignal(data) {
    const { from, fromSocketId, offer, answer, ice, to } = data;

    try {
      let peer = this.peerConnections.get(fromSocketId);

      // If we receive an offer and don't have a peer connection, create one
      if (!peer && offer) {
        const participantInfo = {
          socketId: fromSocketId,
          role: from,
          userName: data.fromUserName || from
        };
        peer = this.createPeerConnection(fromSocketId, participantInfo);

        // If we have a local stream (we're a baby), add our tracks to this peer
        if (this.localStream) {
          this.localStream.getTracks().forEach(track => {
            peer.addTrack(track, this.localStream);
          });
        }
      }

      if (!peer) return;

      if (offer) {
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.socket.emit('signal', { answer, to: fromSocketId });
      }

      if (answer) {
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
      }

      if (ice) {
        await peer.addIceCandidate(new RTCIceCandidate(ice));
      }

    } catch (error) {
      console.error('Error handling signal:', error);
      // esp_peer occasionally emits a malformed SDP offer on reconnect
      // (`a=group:BUNDLE 0` references a mid with no matching `m=audio`).
      // Drop the peer and ask for a fresh offer — usually parses cleanly.
      const broken = data && data.fromSocketId;
      if (broken && data.offer && this.peerConnections.has(broken)) {
        this._retryOffer(broken);
      }
    }
  }

  /**
   * Mute/unmute a specific baby
   */
  muteParticipant(participantId, mute = true) {
    const audio = this.audioElements.get(participantId);
    if (audio) {
      audio.muted = mute;
      return true;
    }
    return false;
  }

  /**
   * Set volume for a specific baby
   */
  setParticipantVolume(participantId, volume) {
    const audio = this.audioElements.get(participantId);
    if (audio) {
      audio.volume = Math.max(0, Math.min(1, volume));
      return true;
    }
    return false;
  }

  /**
   * Set sensitivity for a specific baby
   * @param {string} participantId - The baby's ID
   * @param {number} sensitivity - Sensitivity multiplier (0.5-3.0, default 1.0)
   *   Higher = more sensitive (lower thresholds), Lower = less sensitive (higher thresholds)
   */
  setSensitivity(participantId, sensitivity) {
    const clampedSensitivity = Math.max(0.5, Math.min(3.0, sensitivity));
    this.sensitivity.set(participantId, clampedSensitivity);
    return true;
  }

  /**
   * Remove a participant's connection
   */
  removeParticipant(participantId) {

    // Close peer connection
    const peer = this.peerConnections.get(participantId);
    if (peer) {
      peer.close();
      this.peerConnections.delete(participantId);
    }

    // Remove audio element
    const audio = this.audioElements.get(participantId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      this.audioElements.delete(participantId);
    }

    // Clean up analyser
    const analyser = this.analysers.get(participantId);
    if (analyser) {
      if (analyser.intervalId) clearInterval(analyser.intervalId);
      analyser.source.disconnect();
      analyser.audioContext.close();
      this.analysers.delete(participantId);
    }

    // Remove from maps
    this.audioStreams.delete(participantId);
    this.participants.delete(participantId);
    this.sensitivity.delete(participantId);

    if (this.onStreamRemoved) {
      this.onStreamRemoved(participantId);
    }
  }

}


// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiStreamManager;
}
