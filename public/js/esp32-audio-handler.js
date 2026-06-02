/**
 * ESP32 Audio Handler — processes audio from ESP32 baby devices.
 *
 * Routes incoming binary PCM chunks into the parent's AudioContext for
 * playback, and computes a per-device level for the UI meter.
 *
 * Two visualization paths, selected per chunk by `deviceType`:
 *
 *   - 'esp32-classic' (default) — preserves the long-tuned original
 *     RMS-per-chunk meter with the existing thresholds 100/180.
 *     DO NOT change without explicit user approval; the classic
 *     ESP32 + INMP441 pipeline was calibrated against this.
 *
 *   - 'esp32-s3' — AnalyserNode with a dB range shifted for raw PDM
 *     mic data (-40…-5 dBFS), polled via requestAnimationFrame at
 *     ~60 Hz. Matches the WebRTC PWA-baby meter feel. Thresholds
 *     60/130 because PDM signal sits in a narrower band than the
 *     classic ESP32 with software gain.
 */
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
          // AnalyserNode is wired in PARALLEL to gainNode (from the
          // source — see source-connect below). That decouples it
          // from mute / volume changes: mute the audible output but
          // the meter keeps moving so we can still see if the baby is
          // making noise. AnalyserNode is a passive node — it does not
          // require a destination connection to keep processing.
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

      // Create and play audio buffer. Each PCM frame from the ESP32 is
      // scheduled to start exactly where the previous one ended so there
      // are no gaps/clicks at chunk boundaries — calling start() with
      // no argument starts "as soon as possible," which inserts micro-
      // gaps under network jitter and produces a regular tick pattern
      // proportional to the chunk rate.
      //
      // The per-context nextStartTime clock keeps ~50ms of lead so we
      // can absorb small jitter. If chunks arrive much faster than they
      // play (sustained > MAX_LEAD ahead of currentTime), or much slower
      // (already in the past), we re-anchor with fresh lead — drift
      // would otherwise grow unbounded over a long session.
      const audioBuffer = ctx.audioContext.createBuffer(ctx.channels, amplifiedData.length, ctx.sampleRate);
      audioBuffer.getChannelData(0).set(amplifiedData);
      const source = ctx.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      // Audible branch (subject to mute / volume). Skipped entirely
      // when WebRTC is already playing this baby — otherwise the WSS
      // PCM and the WebRTC Opus paths overlap with a small phase
      // offset and the parent hears an echo.
      const webrtcActive = window._webrtcActiveBabies
        && window._webrtcActiveBabies.has(fromId);
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

      // Classic ESP32 visualization — exact pre-Branch-2 behavior.
      // Per-chunk RMS over the (sensitivity-applied) Float32, scaled
      // ×500, color thresholds 40/120. Untouched on purpose.
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
