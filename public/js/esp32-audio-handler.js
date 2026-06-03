// Plays binary PCM chunks from ESP32 babies and produces a per-device
// level for the UI meter. Two meter paths picked by `deviceType`:
// 'esp32-classic' uses RMS-per-chunk with tuned 100/180 thresholds;
// 'esp32-s3' uses an AnalyserNode in dBFS with 60/130 thresholds.
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
    const tick = () => {
      const ctx = this.contexts.get(fromId);
      if (!ctx || !ctx.analyser) return; // stopped

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
      ctx.levelRafId = requestAnimationFrame(tick);
    };
    const ctx = this.contexts.get(fromId);
    ctx.levelRafId = requestAnimationFrame(tick);
  }

  handleAudioData(data, multiBabyUI) {
    const { fromId, fromName, audio, sampleRate, channels, deviceType } = data;
    this.multiBabyUI = multiBabyUI;
    const isS3 = deviceType === 'esp32-s3';

    try {
      if (!this.contexts.has(fromId)) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 1.0;

        const ctxRecord = {
          audioContext, gainNode,
          sampleRate: sampleRate || 16000,
          channels: channels || 1,
          volume: 1.0,
          buffer: [],
          deviceType: deviceType || 'esp32-classic'
        };

        // gainNode is the mute point — connects to destination only.
        gainNode.connect(audioContext.destination);

        if (isS3) {
          // Analyser branches from the source in parallel to gainNode
          // so muting the audible output doesn't kill the meter.
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.6; // more responsive to taps
          analyser.minDecibels = -40;
          analyser.maxDecibels = -5;

          ctxRecord.analyser = analyser;
          ctxRecord.levelData = new Uint8Array(analyser.frequencyBinCount);
        }

        this.contexts.set(fromId, ctxRecord);

        if (!this.enabled && audioContext.state === 'suspended') {
          if (window._enableAllAudio) window._enableAllAudio();
          if (audioContext.state === 'suspended') {
            const alert = document.getElementById('alert');
            if (alert) {
              alert.innerHTML = 'Tap anywhere to enable audio';
              alert.hidden = false;
            }
          }
        }

        if (isS3) this._startLevelMonitor(fromId);
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
      // with ~50 ms of lead. start() with no argument inserts micro-
      // gaps under jitter and produces a regular tick. Re-anchor with
      // fresh lead if we drift too far ahead or fall into the past.
      const audioBuffer = ctx.audioContext.createBuffer(ctx.channels, amplifiedData.length, ctx.sampleRate);
      audioBuffer.getChannelData(0).set(amplifiedData);
      const source = ctx.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      // Skip WSS playback when WebRTC is actively delivering this
      // baby's audio — both paths overlap into an echo otherwise.
      // Fall back to WSS if the WebRTC track is muted (SRTP failures,
      // ICE renegotiating) so we don't sit on silence.
      const webrtcActive = (function() {
        if (!window._multiStreamManager) return false;
        const stream = window._multiStreamManager.audioStreams.get(fromId);
        if (!stream) return false;
        const tracks = stream.getAudioTracks();
        return tracks.length > 0 && !tracks[0].muted &&
               tracks[0].readyState === 'live';
      })();
      if (!webrtcActive) source.connect(ctx.gainNode);
      // Metering branch (always processed, independent of audible mute
      // or WebRTC takeover — keeps the baby-card level meter alive).
      if (ctx.analyser) source.connect(ctx.analyser);

      const now = ctx.audioContext.currentTime;
      const MIN_LEAD = 0.05;   // 50ms cushion against jitter
      const MAX_LEAD = 0.30;   // re-anchor if scheduling falls > 300ms ahead

      if (!ctx.nextStartTime || ctx.nextStartTime < now + 0.001) {
        ctx.nextStartTime = now + MIN_LEAD;
      } else if (ctx.nextStartTime - now > MAX_LEAD) {
        ctx.nextStartTime = now + MIN_LEAD;
      }
      source.start(ctx.nextStartTime);
      ctx.nextStartTime += audioBuffer.duration;

      // Classic ESP32 meter: per-chunk RMS ×500, color thresholds 40/120.
      // The classic + INMP441 pipeline is calibrated against these
      // exact constants — leave them alone.
      if (!isS3 && multiBabyUI && multiBabyUI.babyCards.has(fromId)) {
        let sumSquares = 0;
        for (let i = 0; i < amplifiedData.length; i++) {
          sumSquares += amplifiedData[i] * amplifiedData[i];
        }
        const rms = Math.sqrt(sumSquares / amplifiedData.length);
        const numericLevel = Math.min(255, Math.floor(rms * 500));

        let levelColor;
        if (numericLevel > 120) levelColor = 'RED';
        else if (numericLevel > 40) levelColor = 'YELLOW';
        else levelColor = 'GREEN';

        multiBabyUI.updateAudioLevel(fromId, levelColor, numericLevel);
      }
    } catch (error) {
      console.error('Error playing ESP32 audio:', error);
    }
  }
}
