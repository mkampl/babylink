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
          const alert = document.getElementById('alert');
          if (alert) {
            alert.innerHTML = '\uD83D\uDD0A <button onclick="window._enableAllAudio()" style="padding: 0.5em 1em; font-size: 1em; cursor: pointer; background: #4CAF50; color: white; border: none; border-radius: 4px;">Click to Enable Audio</button>';
            alert.hidden = false;
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

      // Create and play audio buffer
      const audioBuffer = ctx.audioContext.createBuffer(ctx.channels, amplifiedData.length, ctx.sampleRate);
      audioBuffer.getChannelData(0).set(amplifiedData);
      const source = ctx.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.gainNode);
      source.start();

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
