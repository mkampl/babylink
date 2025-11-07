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

    this.onStreamAdded = null;
    this.onStreamRemoved = null;
    this.onAudioLevelUpdate = null;
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
      console.log(`Received track from ${participantInfo.userName}`);
      const [stream] = event.streams;

      if (stream) {
        this.audioStreams.set(participantId, stream);
        this.createAudioElement(participantId, stream, participantInfo);

        if (this.onStreamAdded) {
          this.onStreamAdded(participantId, stream, participantInfo);
        }
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
    const audio = document.createElement('audio');
    audio.id = `audio-${participantId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    audio.volume = 1.0;
    audio.muted = true; // Start muted, will be controlled by voice detection

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
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
      analyser.getByteFrequencyData(dataArray);

      // Calculate average volume (0-255 range)
      const sum = dataArray.reduce((a, b) => a + b, 0);
      const average = sum / dataArray.length;

      // Find peak value for better sensitivity
      const peak = Math.max(...dataArray);

      // Use peak for level detection (more responsive)
      const volume = peak;

      // Determine level based on peak volume
      let level = 'GREEN';
      if (volume > 80) {
        level = 'RED'; // Crying
      } else if (volume > 30) {
        level = 'YELLOW'; // Movement
      }

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

      // If we receive an offer and don't have a peer connection, create one
      if (!peer && offer) {
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
            console.log(`Added local track to peer for ${fromSocketId}`);
          });
        }
      }

      if (!peer) {
        console.warn('No peer connection for signal', fromSocketId);
        return;
      }

      // Handle offer (typically received by parent from baby)
      if (offer) {
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        this.socket.emit('signal', {
          answer: answer,
          to: fromSocketId
        });

        console.log(`Sent answer to ${fromSocketId}`);
      }

      // Handle answer (received by baby from parent)
      if (answer) {
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`Received answer from ${fromSocketId}`);
      }

      // Handle ICE candidate
      if (ice) {
        await peer.addIceCandidate(new RTCIceCandidate(ice));
        console.log(`Added ICE candidate from ${fromSocketId}`);
      }

    } catch (error) {
      console.error('Error handling signal:', error, data);
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
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiStreamManager;
}
