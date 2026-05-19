/**
 * ESP32 Audio Handler - processes audio from ESP32 baby devices
 */
class ESP32AudioHandler {
  constructor(esp32AudioContexts) {
    this.contexts = esp32AudioContexts;
    this.enabled = false;
  }

  enableAudio() {
    this.enabled = true;
    this.contexts.forEach(ctx => {
      if (ctx.audioContext.state === 'suspended') ctx.audioContext.resume();
    });
  }

  handleAudioData(data, multiBabyUI) {
    const { fromId, fromName, audio, sampleRate, channels } = data;

    try {
      if (!this.contexts.has(fromId)) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 1.0;
        gainNode.connect(audioContext.destination);

        this.contexts.set(fromId, {
          audioContext, gainNode,
          sampleRate: sampleRate || 16000,
          channels: channels || 1,
          volume: 1.0,
          buffer: []
        });

        if (!this.enabled && audioContext.state === 'suspended') {
          // Try auto-enable (works if user already interacted)
          if (window._enableAllAudio) window._enableAllAudio();
          // If still suspended, show hint
          if (audioContext.state === 'suspended') {
            const alert = document.getElementById('alert');
            if (alert) {
              alert.innerHTML = 'Tap anywhere to enable audio';
              alert.hidden = false;
            }
          }
        }
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
      source.connect(ctx.gainNode);

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

      // Update audio level visualization
      if (multiBabyUI && multiBabyUI.babyCards.has(fromId)) {
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
