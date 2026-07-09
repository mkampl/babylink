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

  // Is WebRTC delivering this baby's audio right now? If so, its receiver
  // owns playback and the meter — this PCM handler stays out of the way.
  _webrtcActive(fromId) {
    if (!window._multiStreamManager) return false;
    const stream = window._multiStreamManager.audioStreams.get(fromId);
    if (!stream) return false;
    const tracks = stream.getAudioTracks();
    return tracks.length > 0 && !tracks[0].muted && tracks[0].readyState === 'live';
  }

  _startLevelMonitor(fromId) {
    // setInterval (not rAF) so the meter keeps running in background/hidden
    // tabs. 100 ms ≈ 10 fps — responsive without burning CPU.
    const intervalId = setInterval(() => {
      const ctx = this.contexts.get(fromId);
      if (!ctx || !ctx.analyser) {
        clearInterval(intervalId);
        return;
      }

      // Always read the PCM level and feed the shared health tracker, even
      // when WebRTC is driving — so a wedged (live-but-silent) WebRTC tunnel is
      // detected (WebRTC energy stops, PCM energy continues) and this path can
      // take back over the meter/speaker.
      ctx.analyser.getByteFrequencyData(ctx.levelData);
      let peak = 0;
      for (let i = 0; i < ctx.levelData.length; i++) {
        if (ctx.levelData[i] > peak) peak = ctx.levelData[i];
      }
      const now = Date.now();
      if (typeof getAudioHealth === 'function') {
        getAudioHealth(fromId).markPcmLevel(now, peak);
      }

      // WebRTC owns the meter only while it's actually DELIVERING audio; a
      // wedged silent tunnel yields it back to this PCM path.
      if (typeof getAudioHealth === 'function' &&
          getAudioHealth(fromId).webrtcDelivering(now)) return;

      // Sensitivity scales DETECTION, never the audio: a higher setting lets a
      // quieter sound reach YELLOW/RED. Below 1.0x the thresholds scale down
      // too so RED stays reachable. (Amplifying the samples instead would make
      // sensitivity double as a volume control and clip — the old bug.)
      const sensitivity = ctx.sensitivity || 1.0;
      const adjusted = peak * sensitivity;
      let yellow = 60, red = 130;
      if (sensitivity < 0.71) { yellow = 60 * sensitivity; red = 130 * sensitivity; }

      // Shared LevelMeter: fast attack (no lag) + hysteresis/hold (no flicker).
      const { level, volume } = ctx.meter.push(adjusted, yellow, red, Date.now());

      if (this.multiBabyUI && this.multiBabyUI.babyCards.has(fromId)) {
        this.multiBabyUI.updateAudioLevel(fromId, level, volume);
      }
    }, 100);

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

    // Record that a PCM frame arrived (device is alive, even if this frame is
    // silent). The stall watchdog uses this to surface an honest "no audio"
    // warning when frames stop, instead of a falsely-green "Connected".
    if (typeof getAudioHealth === 'function') getAudioHealth(fromId).markPcmFrame(Date.now());

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
        // Low analyser smoothing — LevelMeter does the envelope smoothing so
        // the meter reacts on the first loud frame (was 0.6 → ~1s lag).
        analyser.smoothingTimeConstant = 0.2;
        analyser.minDecibels = -40;
        analyser.maxDecibels = -5;

        const ctxRecord = {
          audioContext, gainNode, analyser,
          meter: new LevelMeter(),
          levelData: new Uint8Array(analyser.frequencyBinCount),
          sampleRate: sampleRate || 16000,
          channels: channels || 1,
          volume: 1.0,
          worklet: null,      // AudioWorkletNode once the module loads
          arbGain: null,      // gates PCM audibility for the WebRTC arbitration
          workletReady: false,
        };

        // gainNode is the mute point — connects to destination only.
        gainNode.connect(audioContext.destination);

        this.contexts.set(fromId, ctxRecord);

        // Preferred playout: an AudioWorklet jitter buffer (smooth, drift-free)
        // on the audio thread. addModule is async and only works in a secure
        // context; until it's ready — or if it fails/unsupported — we fall back
        // to the per-chunk scheduler below, so PCM always plays.
        if (audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
          audioContext.audioWorklet.addModule('/js/pcm-playout-processor.js').then(() => {
            const rec = this.contexts.get(fromId);
            if (!rec) return; // participant left while loading
            const node = new AudioWorkletNode(audioContext, 'pcm-playout', {
              numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
              processorOptions: { inputRate: rec.sampleRate },
            });
            const arbGain = audioContext.createGain();
            arbGain.gain.value = 1;
            node.connect(arbGain);
            arbGain.connect(rec.gainNode);   // → mute/volume → destination
            node.connect(rec.analyser);      // meter reads the worklet output
            rec.worklet = node;
            rec.arbGain = arbGain;
            rec.workletReady = true;
          }).catch((e) => {
            console.warn('PCM AudioWorklet unavailable — using scheduler fallback:',
                         e && e.message);
          });
        }

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

      // Convert Int16 PCM to Float32 and play as-is. Loudness is the gain
      // node (volume slider); sensitivity is detection-only and must NOT
      // touch the samples here (that made it act like a second, clipping
      // volume control).
      const floatData = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        floatData[i] = pcmData[i] / 32768.0;
      }

      // Play the PCM backup unless WebRTC is actively DELIVERING audio (recent
      // energy) — so a wedged live-but-silent tunnel can never mute us into
      // silence. When WebRTC is really delivering, stay muted to avoid echo.
      // Defaults to audible if the health module is somehow absent.
      const playPcm = (typeof getAudioHealth === 'function')
        ? getAudioHealth(fromId).shouldPlayPcm(Date.now())
        : true;

      if (ctx.workletReady && ctx.worklet) {
        // --- AudioWorklet path: hand samples to the jitter buffer on the audio
        // thread. Audibility is gated by arbGain (WebRTC arbitration); the
        // worklet always consumes (and feeds the meter) so it never backs up.
        ctx.arbGain.gain.value = playPcm ? 1 : 0;
        ctx.worklet.port.postMessage(floatData, [floatData.buffer]);
      } else {
        // --- Fallback: per-chunk scheduled AudioBufferSourceNode. Schedule each
        // chunk where the last ended with ~50 ms lead; re-anchor on drift.
        const audioBuffer = ctx.audioContext.createBuffer(ctx.channels, floatData.length, ctx.sampleRate);
        audioBuffer.getChannelData(0).set(floatData);
        const source = ctx.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        if (playPcm) source.connect(ctx.gainNode);
        source.connect(ctx.analyser); // meter stays live even when muted

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
      }
    } catch (error) {
      console.error('Error playing ESP32 audio:', error);
    }
  }
}
