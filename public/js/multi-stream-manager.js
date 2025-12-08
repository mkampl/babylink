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
    this.audioEnabled = false;        // Track if user has enabled audio playback

    this.onStreamAdded = null;
    this.onStreamRemoved = null;
    this.onAudioLevelUpdate = null;
    this.onAudioEnabled = null; // Callback when audio is enabled by user
  }

  /**
   * Create a peer connection for a specific participant
   */
  createPeerConnection(participantId, participantInfo) {
    if (this.peerConnections.has(participantId)) {
      console.log(`Peer connection already exists for ${participantId}`);
      return this.peerConnections.get(participantId);
    }

    console.log(`Creating peer connection for ${participantInfo.userName} (${participantId})`);

    const peer = new RTCPeerConnection(this.config.iceServers);
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
      console.log(`🎵 Received track from ${participantInfo.userName}`);
      console.log(`  Event:`, event);
      console.log(`  Track:`, event.track);
      console.log(`  Track details: kind=${event.track?.kind}, enabled=${event.track?.enabled}, muted=${event.track?.muted}, readyState=${event.track?.readyState}`);
      console.log(`  Streams array:`, event.streams);
      console.log(`  Streams length:`, event.streams?.length);

      const [stream] = event.streams;

      if (stream) {
        console.log(`  ✅ Stream exists!`);
        console.log(`  Stream ID: ${stream.id}`);
        console.log(`  Stream has ${stream.getTracks().length} track(s)`);
        stream.getTracks().forEach((track, idx) => {
          console.log(`    Track ${idx}: kind=${track.kind}, enabled=${track.enabled}, readyState=${track.readyState}`);
        });

        this.audioStreams.set(participantId, stream);
        this.createAudioElement(participantId, stream, participantInfo);

        if (this.onStreamAdded) {
          this.onStreamAdded(participantId, stream, participantInfo);
        }
      } else {
        console.error(`  ❌ NO STREAM in track event!`);
        console.error(`  This means tracks were not associated with a stream when added`);
      }
    };

    // Handle connection state changes
    peer.onconnectionstatechange = () => {
      console.log(`Connection state for ${participantInfo.userName}: ${peer.connectionState}`);

      if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
        console.warn(`Connection ${peer.connectionState} for ${participantInfo.userName}`);
        // Could trigger reconnection logic here
      }
    };

    return peer;
  }

  /**
   * Create audio element for a participant's stream
   */
  createAudioElement(participantId, stream, participantInfo) {
    console.log(`🔊 Creating audio element for ${participantInfo.userName}`);
    const audio = document.createElement('audio');
    audio.id = `audio-${participantId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    audio.volume = 1.0;
    audio.muted = true; // Start muted to avoid autoplay errors, will unmute on user click

    console.log(`  Audio element created: autoplay=${audio.autoplay}, volume=${audio.volume}, muted=${audio.muted} (will unmute on user click)`);

    // Hide audio element (we'll control it via UI)
    audio.style.display = 'none';
    document.body.appendChild(audio);

    this.audioElements.set(participantId, audio);

    // Initialize audio analysis
    this.initializeAudioAnalysis(participantId, stream, participantInfo);

    // Show prompt to enable audio (matches ESP32 behavior)
    if (this.audioElements.size === 1 && !this.audioEnabled) {
      this.showAudioEnablePrompt();
    }

    console.log(`✅ Audio element ready for ${participantInfo.userName}`);
    return audio;
  }

  /**
   * Initialize audio analysis for voice activity detection
   */
  initializeAudioAnalysis(participantId, stream, participantInfo) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log(`  AudioContext created for ${participantInfo.userName}, state: ${audioContext.state}`);

      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const analysisData = {
        audioContext,
        analyser,
        source,
        dataArray,
        currentLevel: 'GREEN',
        lastUpdate: Date.now()
      };

      this.analysers.set(participantId, analysisData);

      // Start monitoring audio levels
      this.monitorAudioLevel(participantId);

      // If AudioContext is suspended, log it (will be resumed on user gesture)
      if (audioContext.state === 'suspended') {
        console.log(`  ⚠️ AudioContext is suspended - will be resumed when user clicks`);
      }
    } catch (error) {
      console.error(`  ❌ Error initializing audio analysis:`, error);
    }
  }

  /**
   * Monitor audio levels for a specific baby
   */
  monitorAudioLevel(participantId) {
    const analyse = () => {
      if (!this.analysers.has(participantId)) {
        return; // Stop if analyser was removed
      }

      const { analyser, dataArray } = this.analysers.get(participantId);
      analyser.getByteTimeDomainData(dataArray); // Use time-domain for amplitude (0-255, center at 128)

      // Calculate peak amplitude from waveform
      // Time domain data is 0-255 with 128 as the center (silence)
      // Find the maximum deviation from center
      let maxDeviation = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const deviation = Math.abs(dataArray[i] - 128);
        if (deviation > maxDeviation) {
          maxDeviation = deviation;
        }
      }

      // Convert deviation (0-128) to full scale (0-255)
      const peak = maxDeviation * 2;

      // Get sensitivity for this participant (default 1.0 if not set)
      const sensitivity = this.sensitivity.get(participantId) || 1.0;

      // Amplify audio signal based on sensitivity
      // Higher sensitivity (e.g., 2.0) = signal amplified 2x (quieter sounds become louder)
      // Lower sensitivity (e.g., 0.5) = signal attenuated 0.5x (only loud sounds register)
      const adjustedVolume = peak * sensitivity;

      // Use adjusted volume for display (clamped to 0-255)
      const volume = Math.min(255, adjustedVolume);

      // Use FIXED thresholds (sensitivity amplifies the signal, not the thresholds)
      const yellowThreshold = 100;
      const redThreshold = 180;

      // Determine level based on amplified signal and fixed thresholds
      let level = 'GREEN';
      if (adjustedVolume > redThreshold) {
        level = 'RED'; // Crying/Loud noise
      } else if (adjustedVolume > yellowThreshold) {
        level = 'YELLOW'; // Movement/Talking
      }
      // GREEN: 0-yellowThreshold (quiet/background noise)

      // Always call the callback with current values (not just on change)
      if (this.onAudioLevelUpdate) {
        this.onAudioLevelUpdate(participantId, level, volume);
      }

      // Store level in analysis data
      const analysisData = this.analysers.get(participantId);
      if (analysisData) {
        const levelChanged = analysisData.currentLevel !== level;
        analysisData.currentLevel = level;
        if (levelChanged) {
          analysisData.lastUpdate = Date.now();
        }
      }

      requestAnimationFrame(analyse);
    };

    analyse();
  }

  /**
   * Handle incoming WebRTC signal (offer/answer/ICE)
   */
  async handleSignal(data) {
    const { from, fromSocketId, offer, answer, ice, to } = data;

    try {
      // Get the peer connection for this participant
      let peer = this.peerConnections.get(fromSocketId);
      console.log(`📡 handleSignal from ${fromSocketId}:`, { hasOffer: !!offer, hasAnswer: !!answer, hasIce: !!ice, peerExists: !!peer });

      // If we receive an offer and don't have a peer connection, create one
      if (!peer && offer) {
        console.log(`🆕 Creating new peer connection for incoming offer from ${data.fromUserName || fromSocketId}`);
        const participantInfo = {
          socketId: fromSocketId,
          role: from,
          userName: data.fromUserName || from
        };
        peer = this.createPeerConnection(fromSocketId, participantInfo);

        // If we have a local stream (we're a baby), add tracks to this peer
        if (this.localStream) {
          this.localStream.getTracks().forEach(track => {
            peer.addTrack(track, this.localStream);
            console.log(`  ➕ Added local ${track.kind} track to peer for ${fromSocketId}`);
          });
        }
      }

      if (!peer) {
        console.warn('❌ No peer connection for signal', fromSocketId);
        return;
      }

      // Handle offer (typically received by parent from baby)
      if (offer) {
        console.log(`📥 Processing offer from ${fromSocketId}, current state: ${peer.signalingState}`);
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`  Remote description set, new state: ${peer.signalingState}`);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        console.log(`  Answer created and set, final state: ${peer.signalingState}`);

        this.socket.emit('signal', {
          answer: answer,
          to: fromSocketId
        });

        console.log(`📤 Sent answer to ${fromSocketId}`);
      }

      // Handle answer (received by baby from parent)
      if (answer) {
        console.log(`📥 Processing answer from ${fromSocketId}, current state: ${peer.signalingState}`);
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`  Answer set, new state: ${peer.signalingState}`);
      }

      // Handle ICE candidate
      if (ice) {
        await peer.addIceCandidate(new RTCIceCandidate(ice));
        console.log(`🧊 Added ICE candidate from ${fromSocketId}`);
      }

    } catch (error) {
      console.error('❌ Error handling signal:', error, data);
      console.error('  Error stack:', error.stack);
    }
  }

  /**
   * Add local stream (for baby device)
   */
  async addLocalStream(stream) {
    // Add tracks to all peer connections
    for (const [participantId, peer] of this.peerConnections.entries()) {
      stream.getTracks().forEach(track => {
        peer.addTrack(track, stream);
      });

      // Create and send offer
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      this.socket.emit('signal', {
        offer: offer,
        to: participantId
      });
    }
  }

  /**
   * Mute/unmute a specific baby
   */
  muteParticipant(participantId, mute = true) {
    const audio = this.audioElements.get(participantId);
    if (audio) {
      audio.muted = mute;
      console.log(`${mute ? 'Muted' : 'Unmuted'} ${participantId}`);
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
   * @param {number} sensitivity - Sensitivity multiplier (0.2-5.0, default 1.0)
   *   Higher = more sensitive (lower thresholds), Lower = less sensitive (higher thresholds)
   */
  setSensitivity(participantId, sensitivity) {
    // Clamp sensitivity to reasonable range
    const clampedSensitivity = Math.max(0.2, Math.min(5.0, sensitivity));
    this.sensitivity.set(participantId, clampedSensitivity);
    console.log(`Set sensitivity for ${participantId} to ${clampedSensitivity.toFixed(1)}x`);
    return true;
  }

  /**
   * Remove a participant's connection
   */
  removeParticipant(participantId) {
    console.log(`Removing participant ${participantId}`);

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

  /**
   * Clean up all connections
   */
  cleanup() {
    for (const participantId of this.peerConnections.keys()) {
      this.removeParticipant(participantId);
    }
  }

  /**
   * Get all current participants
   */
  getParticipants() {
    return Array.from(this.participants.values());
  }

  /**
   * Get audio level for a specific participant
   */
  getAudioLevel(participantId) {
    const analyser = this.analysers.get(participantId);
    return analyser ? analyser.currentLevel : 'UNKNOWN';
  }

  /**
   * Show prompt to enable audio (matches ESP32 behavior)
   */
  showAudioEnablePrompt() {
    const alert = document.getElementById('alert');
    if (!alert) return;

    alert.innerHTML = '🔊 Click anywhere on the page to enable audio playback';
    alert.hidden = false;

    // Auto-enable on any user interaction
    const enableOnClick = async () => {
      await this.enableAudio();
      alert.hidden = true;
      document.removeEventListener('click', enableOnClick);
    };
    document.addEventListener('click', enableOnClick, { once: true });
  }

  /**
   * Enable audio playback (resumes contexts, unmutes audio elements)
   */
  async enableAudio() {
    this.audioEnabled = true;
    console.log('🎧 Audio playback enabled');

    // Unmute and play all audio elements
    for (const [id, audio] of this.audioElements) {
      try {
        audio.muted = false;
        await audio.play();
        console.log(`  ✅ Unmuted and playing ${id}`);

        // Notify UI that audio was enabled
        if (this.onAudioEnabled) {
          this.onAudioEnabled(id);
        }
      } catch (e) {
        console.log(`  ⚠️ Audio element ${id}:`, e.message);
      }
    }

    // Resume all audio contexts
    for (const [id, analyserData] of this.analysers) {
      if (analyserData.audioContext && analyserData.audioContext.state === 'suspended') {
        await analyserData.audioContext.resume();
        console.log(`  ✅ Resumed AudioContext for ${id}`);
      }
    }

    console.log('✅ Audio fully enabled');
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiStreamManager;
}
