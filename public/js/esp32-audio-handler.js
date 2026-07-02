// Plays binary PCM chunks from ESP32-S3 babies and produces a per-device
// level for the UI meter via an AnalyserNode (dBFS, 60/130 thresholds).
class ESP32AudioHandler {
  constructor(esp32AudioContexts) {
    this.contexts = esp32AudioContexts;
    this.enabled = false;
    this.multiBabyUI = null; // captured on first audio chunk
  }

  enableAudio() {
    this.enabled = true;
    this.contexts.forEach(ctx => {
      if (ctx.audioContext.state === 'suspended') ctx.audioContext.resume();
    });
  }

  _startLevelMonitor(fromId) {
    // setInterval keeps the meter running in background/hidden tabs.
    // rAF is throttled to 1 fps or suspended entirely when the tab is
    // hidden, which would freeze crying detection and auto-mute logic.
    const intervalId = setInterval(() => {
      const ctx = this.contexts.get(fromId);
      if (!ctx || !ctx.analyser) {
        clearInterval(intervalId);
        return;
      }

      ctx.analyser.getByteFrequencyData(ctx.levelData);
      let peak = 0;
      for (let i = 0; i < ctx.levelData.length; i++) {
        if (ctx.levelData[i] > peak) peak = ctx.levelData[i];
      }
      const volume = peak; // 0..255

      let level = 'GREEN';
      if (volume > 130)      level = 'RED';
      else if (volume > 60)  level = 'YELLOW';

      if (this.multiBabyUI && this.multiBabyUI.babyCards.has(fromId)) {
        this.multiBabyUI.updateAudioLevel(fromId, level, volume);
      }
    }, 250);

    const ctx = this.contexts.get(fromId);
    ctx.levelIntervalId = intervalId;
  }

  /**
   * Release all resources for a departed participant.
   * Call this from app.js participant-left when role === 'parent'.
   */
  removeContext(fromId) {
    const ctx = this.contexts.get(fromId);
    if (!ctx) return;
    if (ctx.levelIntervalId) clearInterval(ctx.levelIntervalId);
    try { ctx.audioContext.close(); } catch (e) {}
    this.contexts.delete(fromId);
  }

  handleAudioData(data, multiBabyUI) {
    const { fromId, audio, sampleRate, channels } = data;
    this.multiBabyUI = multiBabyUI;

    try {
      if (!this.contexts.has(fromId)) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const gainNode = audioContext.createGain();
        // The context is created lazily on the first audio frame, after
        // addBaby has already set the baby to muted. Start the gain in sync
        // with the card's mute state — otherwise the meter shows "Muted"
        // while PCM plays at full volume, and auto-mute never engages because
        // it thinks the baby is already muted.
        const startMuted = !!(this.multiBabyUI && this.multiBabyUI.isMuted &&
                              this.multiBabyUI.isMuted.get(fromId));
        gainNode.gain.value = startMuted ? 0 : 1.0;

        // Analyser branches from the source in parallel to gainNode
        // so muting the audible output doesn't kill the meter.
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        analyser.minDecibels = -40;
        analyser.maxDecibels = -5;

        const ctxRecord = {
          audioContext, gainNode, analyser,
          levelData: new Uint8Array(analyser.frequencyBinCount),
          sampleRate: sampleRate || 16000,
          channels: channels || 1,
          volume: 1.0,
        };

        // gainNode is the mute point — connects to destination only.
        gainNode.connect(audioContext.destination);

        this.contexts.set(fromId, ctxRecord);

        if (!this.enabled && audioContext.state === 'suspended') {
          if (window._enableAllAudio) window._enableAllAudio();
          if (audioContext.state === 'suspended') {
            const alert = document.getElementById('alert');
            if (alert) {
              alert.textContent = 'Tap anywhere to enable audio';
              alert.hidden = false;
            }
          }
        }

        this._startLevelMonitor(fromId);
      }

      const ctx = this.contexts.get(fromId);
      if (ctx.audioContext.state === 'suspended') return;

      // Convert to Int16Array
      let pcmData;
      if (audio.data) {
        pcmData = new Int16Array(audio.data);
      } else if (audio instanceof ArrayBuffer) {
        pcmData = new Int16Array(audio);
      } else if (Array.isArray(audio)) {
        pcmData = new Int16Array(audio);
      } else {
        return;
      }

      // Convert Int16 PCM to Float32
      const floatData = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        floatData[i] = pcmData[i] / 32768.0;
      }

      // Apply sensitivity gain
      const sensitivityGain = ctx.sensitivityGain || 1.0;
      const amplifiedData = new Float32Array(floatData.length);
      for (let i = 0; i < floatData.length; i++) {
        amplifiedData[i] = Math.max(-1.0, Math.min(1.0, floatData[i] * sensitivityGain));
      }

      // Schedule each chunk to start where the previous one ended,
      // with ~50 ms of lead. Re-anchor if we drift too far ahead or
      // fall into the past.
      const audioBuffer = ctx.audioContext.createBuffer(ctx.channels, amplifiedData.length, ctx.sampleRate);
      audioBuffer.getChannelData(0).set(amplifiedData);
      const source = ctx.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      // Skip WSS playback when WebRTC is actively delivering this
      // baby's audio — both paths overlap into an echo otherwise.
      const webrtcActive = (function() {
        if (!window._multiStreamManager) return false;
        const stream = window._multiStreamManager.audioStreams.get(fromId);
        if (!stream) return false;
        const tracks = stream.getAudioTracks();
        return tracks.length > 0 && !tracks[0].muted &&
               tracks[0].readyState === 'live';
      })();
      if (!webrtcActive) source.connect(ctx.gainNode);
      // Metering branch — always processed regardless of audible mute
      // or WebRTC takeover so the baby-card level meter stays live.
      source.connect(ctx.analyser);

      const now = ctx.audioContext.currentTime;
      const MIN_LEAD = 0.05;
      const MAX_LEAD = 0.30;

      if (!ctx.nextStartTime || ctx.nextStartTime < now + 0.001) {
        ctx.nextStartTime = now + MIN_LEAD;
      } else if (ctx.nextStartTime - now > MAX_LEAD) {
        ctx.nextStartTime = now + MIN_LEAD;
      }
      source.start(ctx.nextStartTime);
      ctx.nextStartTime += audioBuffer.duration;
    } catch (error) {
      console.error('Error playing ESP32 audio:', error);
    }
  }
}
