/**
 * Alarm Manager - acoustic alarm for baby disconnection
 */
class AlarmManager {
  constructor() {
    this.isPlaying = false;
    this.timeout = null;
    this.audioContext = null;
  }

  /**
   * Create/resume the alarm's AudioContext. Call this from a user gesture
   * (the Start Monitoring tap): iOS/Safari only lets a context started from
   * a gesture produce sound, and the alarm itself fires from a socket event.
   */
  unlock() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      const p = this.audioContext.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  play() {
    if (this.isPlaying) return;
    console.log('Playing acoustic alarm - baby disconnected');
    this.isPlaying = true;
    // Normally already unlocked by the Start Monitoring tap; if not (or the
    // browser suspended it since), this is the best remaining effort.
    this.unlock();
    this._beepSequence();
  }

  stop() {
    if (!this.isPlaying) return;
    console.log('Stopping acoustic alarm');
    this.isPlaying = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  schedule(delay, conditionFn) {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      if (conditionFn()) this.play();
      this.timeout = null;
    }, delay);
  }

  _beepSequence() {
    if (!this.isPlaying || !this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
    osc.start(this.audioContext.currentTime);
    osc.stop(this.audioContext.currentTime + 0.3);
    if (this.isPlaying) {
      setTimeout(() => this._beepSequence(), 600);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AlarmManager;
}
