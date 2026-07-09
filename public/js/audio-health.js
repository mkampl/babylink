// Per-baby audio-path health & arbitration.
//
// The ESP sends audio on TWO paths at once — WebRTC (Opus, low latency) and a
// raw-PCM stream relayed over the socket as a constant safety net. The browser
// plays WebRTC when it's good and the PCM copy otherwise. The danger this
// module removes: esp_peer can wedge into a "live but silent" tunnel — the
// MediaStreamTrack still reports live/unmuted while no real audio comes out.
// The old arbitration muted the PCM backup whenever the track was "live", so a
// wedged tunnel produced SILENCE while the card still showed a happy green
// "Connected" — a baby could be crying and the parent would hear nothing and
// not know. Not acceptable for a monitor.
//
// Fix: decide on actual AUDIO ENERGY, not track state.
//   - shouldPlayPcm(): play the PCM backup unless WebRTC has produced real
//     audio energy very recently. Covers WebRTC-down AND wedged-live-silent —
//     the meter/speaker never go silent while the device is alive.
//   - status(): 'webrtc' | 'backup' | 'quiet' | 'stalled'. 'stalled' (no PCM
//     frames for a while AND WebRTC not delivering) is the honest "no audio,
//     reconnecting" signal the UI surfaces so the parent can trust green =
//     really hearing the baby.
//
// Pure and time-injectable (now passed in) → unit-tested with no browser/audio.

(function (global) {
  'use strict';

  const DEFAULTS = {
    energyThresh: 12,      // analyser peak (0..255) that counts as real sound
    webrtcWindowMs: 900,   // WebRTC "delivering" if energy seen within this
    pcmEnergyWindowMs: 900,
    stallMs: 8000,         // no PCM frame this long → device/tunnel stalled
  };

  class AudioHealth {
    constructor(opts) {
      opts = opts || {};
      this.energyThresh = opts.energyThresh != null ? opts.energyThresh : DEFAULTS.energyThresh;
      this.webrtcWindowMs = opts.webrtcWindowMs != null ? opts.webrtcWindowMs : DEFAULTS.webrtcWindowMs;
      this.pcmEnergyWindowMs = opts.pcmEnergyWindowMs != null ? opts.pcmEnergyWindowMs : DEFAULTS.pcmEnergyWindowMs;
      this.stallMs = opts.stallMs != null ? opts.stallMs : DEFAULTS.stallMs;

      this.lastWebrtcEnergyMs = -Infinity;
      this.lastPcmEnergyMs = -Infinity;
      this.lastPcmFrameMs = -Infinity;
    }

    /** WebRTC analyser sample (multi-stream-manager, ~10 Hz). */
    markWebrtcLevel(now, volume) {
      if (volume > this.energyThresh) this.lastWebrtcEnergyMs = now;
    }

    /** PCM analyser sample (esp32-audio-handler level monitor, ~10 Hz). */
    markPcmLevel(now, peak) {
      if (peak > this.energyThresh) this.lastPcmEnergyMs = now;
    }

    /** A PCM audio frame arrived (device is alive, even if silent). ~15 Hz. */
    markPcmFrame(now) {
      this.lastPcmFrameMs = now;
    }

    webrtcDelivering(now) {
      return now - this.lastWebrtcEnergyMs < this.webrtcWindowMs;
    }

    pcmHasSound(now) {
      return now - this.lastPcmEnergyMs < this.pcmEnergyWindowMs;
    }

    pcmArriving(now) {
      return now - this.lastPcmFrameMs < this.stallMs;
    }

    /**
     * Route the PCM backup to the speaker unless WebRTC is actively delivering
     * audio. Erring toward "play PCM" is deliberate: the monitor must never go
     * silent while the device is alive. When WebRTC IS delivering, we mute PCM
     * to avoid a doubled echo.
     */
    shouldPlayPcm(now) {
      return !this.webrtcDelivering(now);
    }

    /**
     * Honest health state for the card:
     *   webrtc  – hearing the baby over WebRTC
     *   backup  – WebRTC not delivering but the PCM backup has live sound
     *   quiet   – device alive, room quiet (nothing to hear)
     *   stalled – no audio arriving on either path → surface "reconnecting"
     */
    status(now) {
      if (this.webrtcDelivering(now)) return 'webrtc';
      if (this.pcmArriving(now)) return this.pcmHasSound(now) ? 'backup' : 'quiet';
      return 'stalled';
    }
  }

  AudioHealth.DEFAULTS = DEFAULTS;

  // Shared per-baby registry so the WebRTC path (multi-stream-manager) and the
  // PCM path (esp32-audio-handler) feed and read the SAME health object. Keyed
  // by the participant/device id — the same key both paths already use for
  // arbitration, so they always agree.
  function getAudioHealth(id) {
    if (!global._audioHealth) global._audioHealth = new Map();
    let h = global._audioHealth.get(id);
    if (!h) { h = new AudioHealth(); global._audioHealth.set(id, h); }
    return h;
  }
  function dropAudioHealth(id) {
    if (global._audioHealth) global._audioHealth.delete(id);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioHealth;
  } else {
    global.AudioHealth = AudioHealth;
    global.getAudioHealth = getAudioHealth;
    global.dropAudioHealth = dropAudioHealth;
  }
})(typeof window !== 'undefined' ? window : globalThis);
