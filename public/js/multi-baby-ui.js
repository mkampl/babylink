// public/js/multi-baby-ui.js
// UI manager for displaying multiple babies in parent monitoring view

class MultiBabyUI {
  constructor(container) {
    this.container = typeof container === 'string'
      ? document.getElementById(container)
      : container;

    this.babyCards = new Map(); // babyId → DOM element
    this.audioLevels = new Map(); // babyId → current level
    this.activityLogs = new Map(); // babyId → log entries
    this.autoMuteTimers = new Map(); // babyId → timeout ID
    this.isMuted = new Map(); // babyId → mute state
    this.isManuallyMuted = new Map(); // babyId → manual mute override
    this.lastLevelChangeTime = new Map(); // babyId → timestamp
    this.sensitivity = new Map(); // babyId → sensitivity multiplier (0.5-3.0, default 1.0)

    this.onMuteToggle = null;
    this.onSoloToggle = null;
    this.onVolumeChange = null;
    this.onSensitivityChange = null;

    this.init();
  }

  init() {
    // Create master controls
    this.createMasterControls();

    // Create babies grid container
    this.babiesGrid = document.createElement('div');
    this.babiesGrid.className = 'babies-grid';
    this.babiesGrid.id = 'babiesGrid';
    this.container.appendChild(this.babiesGrid);

    // Add styles
    this.injectStyles();
  }

  /**
   * Create master controls for all babies
   */
  createMasterControls() {
    const masterControls = document.createElement('div');
    masterControls.className = 'master-controls';
    masterControls.innerHTML = `
      <h2>👶 Baby Monitors</h2>
      <div class="master-buttons">
        <button id="muteAllBtn" class="btn btn-danger">🔇 Mute All</button>
        <button id="unmuteAllBtn" class="btn btn-success">🔊 Unmute All</button>
      </div>
      <div id="masterStatus" class="master-status">
        <span id="babyCount">0 babies connected</span>
      </div>
    `;

    this.container.appendChild(masterControls);

    // Add event listeners
    document.getElementById('muteAllBtn').addEventListener('click', () => {
      this.muteAll(true);
    });

    document.getElementById('unmuteAllBtn').addEventListener('click', () => {
      this.muteAll(false);
    });
  }

  /**
   * Add a baby card to the UI
   */
  addBaby(babyId, babyInfo) {
    if (this.babyCards.has(babyId)) {
      console.log(`Baby card already exists for ${babyId}`);
      return;
    }

    const babyName = babyInfo.userName || `Baby ${this.babyCards.size + 1}`;

    const card = document.createElement('div');
    card.className = 'baby-card';
    card.dataset.babyId = babyId;
    card.innerHTML = `
      <div class="baby-header">
        <h3 class="baby-name">👶 ${this.escapeHtml(babyName)}</h3>
        <span class="baby-status" id="status-${babyId}">🟢 Connected</span>
      </div>

      <div class="audio-visualization">
        <div class="volume-meter-container">
          <div class="volume-meter" id="meter-${babyId}" style="width: 0%"></div>
        </div>
        <div class="audio-level-indicator" id="level-${babyId}">
          <span class="level-badge level-green">Quiet</span>
        </div>
      </div>

      <div class="baby-controls">
        <button class="btn btn-mute" id="mute-${babyId}" data-muted="true">
          🔇 Muted
        </button>
        <button class="btn btn-solo" id="solo-${babyId}" title="Listen to only this baby">
          🎧 Solo
        </button>
        <div class="volume-control">
          <label>Volume:</label>
          <input type="range" id="volume-${babyId}" min="0" max="100" value="100" />
          <span id="volume-value-${babyId}">100%</span>
        </div>
        <div class="sensitivity-control">
          <label title="Adjust sensitivity for different microphones and room noise levels">Sensitivity:</label>
          <input type="range" id="sensitivity-${babyId}" min="20" max="500" value="100" step="10" />
          <span id="sensitivity-value-${babyId}">1.0x</span>
        </div>
      </div>

      <div class="baby-activity-log" id="log-${babyId}">
        <strong>Activity Log:</strong>
        <div class="log-entries" id="log-entries-${babyId}"></div>
      </div>
    `;

    this.babiesGrid.appendChild(card);
    this.babyCards.set(babyId, card);
    this.audioLevels.set(babyId, 'GREEN');
    this.activityLogs.set(babyId, []);
    this.isMuted.set(babyId, true); // Start muted
    this.isManuallyMuted.set(babyId, false); // Not manually controlled yet
    this.sensitivity.set(babyId, 1.0); // Default sensitivity (1.0x)

    // Add event listeners
    this.setupCardEventListeners(babyId);

    // Update count
    this.updateBabyCount();

    // Log activity
    this.logActivity(babyId, `${babyName} connected`, 'success');
  }

  /**
   * Setup event listeners for a baby card
   */
  setupCardEventListeners(babyId) {
    // Mute button
    const muteBtn = document.getElementById(`mute-${babyId}`);
    muteBtn.addEventListener('click', () => {
      const currentlyMuted = this.isMuted.get(babyId);

      if (currentlyMuted) {
        // User wants to unmute - clear manual flag to allow auto-mute to resume
        this.isManuallyMuted.set(babyId, false);
        this.unmuteBaby(babyId, 'manual');
        this.logActivity(babyId, '🔊 Manually unmuted (auto-mute will resume)', 'manual');

        // If currently quiet, immediately set auto-mute timer
        const currentLevel = this.audioLevels.get(babyId);
        if (currentLevel === 'GREEN') {
          const timer = setTimeout(() => {
            if (this.audioLevels.get(babyId) === 'GREEN' && !this.isManuallyMuted.get(babyId)) {
              this.muteBaby(babyId, 'auto');
              this.logActivity(babyId, '🔇 Auto-muted (quiet)', 'auto');
            }
          }, 5000);
          this.autoMuteTimers.set(babyId, timer);
        }
      } else {
        // User wants to mute
        this.isManuallyMuted.set(babyId, true);
        this.muteBaby(babyId, 'manual');
        this.logActivity(babyId, '🔇 Manually muted', 'manual');

        // Clear any auto-unmute timers
        const timer = this.autoMuteTimers.get(babyId);
        if (timer) {
          clearTimeout(timer);
          this.autoMuteTimers.delete(babyId);
        }
      }
    });

    // Solo button
    const soloBtn = document.getElementById(`solo-${babyId}`);
    soloBtn.addEventListener('click', () => {
      if (this.onSoloToggle) {
        this.onSoloToggle(babyId);
      }
      this.logActivity(babyId, 'Solo mode activated', 'info');
    });

    // Volume slider
    const volumeSlider = document.getElementById(`volume-${babyId}`);
    const volumeValue = document.getElementById(`volume-value-${babyId}`);

    volumeSlider.addEventListener('input', (e) => {
      const value = e.target.value;
      volumeValue.textContent = `${value}%`;

      if (this.onVolumeChange) {
        this.onVolumeChange(babyId, value / 100);
      }
    });

    // Sensitivity slider
    const sensitivitySlider = document.getElementById(`sensitivity-${babyId}`);
    const sensitivityValue = document.getElementById(`sensitivity-value-${babyId}`);

    sensitivitySlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      const sensitivity = value / 100; // Convert 50-300 to 0.5-3.0
      this.sensitivity.set(babyId, sensitivity);
      sensitivityValue.textContent = `${sensitivity.toFixed(1)}x`;

      console.log(`${babyId}: Sensitivity adjusted to ${sensitivity.toFixed(1)}x`);
      this.logActivity(babyId, `Sensitivity set to ${sensitivity.toFixed(1)}x`, 'info');

      // Notify stream manager of sensitivity change if callback exists
      if (this.onSensitivityChange) {
        this.onSensitivityChange(babyId, sensitivity);
      }
    });
  }

  /**
   * Remove a baby card from the UI
   */
  removeBaby(babyId) {
    const card = this.babyCards.get(babyId);
    if (card) {
      // Clear any timers
      const timer = this.autoMuteTimers.get(babyId);
      if (timer) {
        clearTimeout(timer);
        this.autoMuteTimers.delete(babyId);
      }

      // Clean up all state
      card.remove();
      this.babyCards.delete(babyId);
      this.audioLevels.delete(babyId);
      this.activityLogs.delete(babyId);
      this.isMuted.delete(babyId);
      this.isManuallyMuted.delete(babyId);
      this.lastLevelChangeTime.delete(babyId);
      this.sensitivity.delete(babyId);

      this.updateBabyCount();
    }
  }

  /**
   * Update audio level for a specific baby
   */
  updateAudioLevel(babyId, level, volume) {
    const previousLevel = this.audioLevels.get(babyId);
    this.audioLevels.set(babyId, level);

    // Update volume meter
    const meter = document.getElementById(`meter-${babyId}`);
    if (meter) {
      const percentage = Math.round((volume / 255) * 100);
      meter.style.width = `${percentage}%`;

      // Update color based on level
      if (level === 'RED') {
        meter.style.background = '#F44336';
      } else if (level === 'YELLOW') {
        meter.style.background = '#FFC107';
      } else {
        meter.style.background = '#4CAF50';
      }
    }

    // Update level indicator
    const levelIndicator = document.getElementById(`level-${babyId}`);
    if (levelIndicator) {
      let levelText = 'Quiet';
      let levelClass = 'level-green';

      if (level === 'RED') {
        levelText = 'Crying!';
        levelClass = 'level-red';
        // Only log once when level changes to RED
        if (previousLevel !== 'RED') {
          this.logActivity(babyId, '🚨 Baby is crying!', 'alert');
        }
      } else if (level === 'YELLOW') {
        levelText = 'Movement';
        levelClass = 'level-yellow';
      }

      levelIndicator.innerHTML = `<span class="level-badge ${levelClass}">${levelText}</span>`;
    }

    // Update status with pulsing effect for crying
    const status = document.getElementById(`status-${babyId}`);
    if (status && level === 'RED') {
      status.className = 'baby-status status-alert pulsing';
      status.textContent = '🔴 Crying';
    } else if (status) {
      status.className = 'baby-status';
      status.textContent = '🟢 Connected';
    }

    // Auto-mute/unmute logic
    this.handleAutoMuteLogic(babyId, level, previousLevel);
  }

  /**
   * Handle automatic muting/unmuting based on audio levels
   */
  handleAutoMuteLogic(babyId, level, previousLevel) {
    // Don't auto-mute if user has manually muted (but crying overrides this)
    if (this.isManuallyMuted.get(babyId) && level !== 'RED') {
      console.log(`Auto-mute blocked for ${babyId}: manually muted`);
      return;
    }

    // Only process if level actually changed or there's no existing timer
    const levelChanged = level !== previousLevel;
    const hasExistingTimer = this.autoMuteTimers.has(babyId);

    // If level hasn't changed and we already have a timer, don't reset it
    if (!levelChanged && hasExistingTimer) {
      return;
    }

    // Clear any existing timer when level changes
    if (levelChanged && hasExistingTimer) {
      const existingTimer = this.autoMuteTimers.get(babyId);
      clearTimeout(existingTimer);
      this.autoMuteTimers.delete(babyId);
      console.log(`${babyId}: Cleared existing timer due to level change (${previousLevel} → ${level})`);
    }

    // Track level change time
    if (levelChanged) {
      this.lastLevelChangeTime.set(babyId, Date.now());
    }

    if (level === 'RED') {
      // CRYING - Immediately unmute (override manual mute)
      const wasMuted = this.isMuted.get(babyId);
      const wasManuallyMuted = this.isManuallyMuted.get(babyId);

      if (wasMuted) {
        this.unmuteBaby(babyId, 'auto');
        const message = wasManuallyMuted
          ? '🔊 Auto-unmuted (crying detected - overriding manual mute)'
          : '🔊 Auto-unmuted (crying detected)';
        this.logActivity(babyId, message, 'auto');
        console.log(`${babyId}: CRYING - Unmuted (was manually muted: ${wasManuallyMuted})`);
      }

      // Override manual mute when crying
      this.isManuallyMuted.set(babyId, false);

    } else if (level === 'YELLOW') {
      // MOVEMENT - Unmute after brief delay (only if currently muted)
      if (this.isMuted.get(babyId) && !hasExistingTimer) {
        console.log(`${babyId}: MOVEMENT - Setting unmute timer (2s)`);
        const timer = setTimeout(() => {
          if (this.audioLevels.get(babyId) !== 'GREEN' && !this.isManuallyMuted.get(babyId)) {
            this.unmuteBaby(babyId, 'auto');
            this.logActivity(babyId, '🔊 Auto-unmuted (movement detected)', 'auto');
            console.log(`${babyId}: Auto-unmuted after movement`);
          } else {
            console.log(`${babyId}: Unmute timer cancelled (level changed or manually muted)`);
          }
          this.autoMuteTimers.delete(babyId);
        }, 2000);
        this.autoMuteTimers.set(babyId, timer);
      }

    } else if (level === 'GREEN') {
      // QUIET - Auto-mute after delay (only set timer on level change to GREEN)
      if (levelChanged && !this.isMuted.get(babyId)) {
        const wasCrying = previousLevel === 'RED';
        const muteDelay = wasCrying ? 10000 : 5000; // 10s after crying, 5s otherwise

        console.log(`${babyId}: QUIET - Setting mute timer (${muteDelay/1000}s, was crying: ${wasCrying})`);

        const timer = setTimeout(() => {
          if (this.audioLevels.get(babyId) === 'GREEN' && !this.isManuallyMuted.get(babyId)) {
            this.muteBaby(babyId, 'auto');
            this.logActivity(babyId, '🔇 Auto-muted (quiet)', 'auto');
            console.log(`${babyId}: Auto-muted after quiet period`);
          } else {
            console.log(`${babyId}: Mute timer cancelled (level changed or manually muted)`);
          }
          this.autoMuteTimers.delete(babyId);
        }, muteDelay);
        this.autoMuteTimers.set(babyId, timer);
      }
    }
  }

  /**
   * Mute a baby (internal method)
   */
  muteBaby(babyId, source = 'manual') {
    this.isMuted.set(babyId, true);
    if (this.onMuteToggle) {
      this.onMuteToggle(babyId, true);
    }

    // Update button state
    const muteBtn = document.getElementById(`mute-${babyId}`);
    if (muteBtn) {
      muteBtn.dataset.muted = 'true';
      muteBtn.textContent = '🔇 Muted';
      muteBtn.className = 'btn btn-mute muted';
    }
  }

  /**
   * Unmute a baby (internal method)
   */
  unmuteBaby(babyId, source = 'manual') {
    this.isMuted.set(babyId, false);
    if (this.onMuteToggle) {
      this.onMuteToggle(babyId, false);
    }

    // Update button state
    const muteBtn = document.getElementById(`mute-${babyId}`);
    if (muteBtn) {
      muteBtn.dataset.muted = 'false';
      muteBtn.textContent = '🔊 Unmuted';
      muteBtn.className = 'btn btn-mute';
    }
  }

  /**
   * Update baby connection status
   */
  updateBabyStatus(babyId, connected, reason = '') {
    const status = document.getElementById(`status-${babyId}`);
    if (status) {
      if (connected) {
        status.textContent = '🟢 Connected';
        status.className = 'baby-status';
      } else {
        status.textContent = '🔴 Disconnected';
        status.className = 'baby-status status-error';
        this.logActivity(babyId, `Disconnected: ${reason}`, 'error');
      }
    }
  }

  /**
   * Log activity for a specific baby
   */
  logActivity(babyId, message, type = 'info') {
    const logEntries = document.getElementById(`log-entries-${babyId}`);
    if (!logEntries) return;

    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `<span class="log-time">${timestamp}</span> ${this.escapeHtml(message)}`;

    logEntries.appendChild(entry);
    logEntries.scrollTop = logEntries.scrollHeight;

    // Keep only last 20 entries
    while (logEntries.children.length > 20) {
      logEntries.removeChild(logEntries.firstChild);
    }

    // Store in memory
    const logs = this.activityLogs.get(babyId) || [];
    logs.push({ timestamp, message, type });
    if (logs.length > 50) logs.shift();
    this.activityLogs.set(babyId, logs);
  }

  /**
   * Mute/unmute all babies
   */
  muteAll(mute) {
    for (const babyId of this.babyCards.keys()) {
      const muteBtn = document.getElementById(`mute-${babyId}`);
      if (muteBtn) {
        muteBtn.dataset.muted = mute;
        muteBtn.textContent = mute ? '🔇 Muted' : '🔊 Unmuted';
        muteBtn.className = mute ? 'btn btn-mute muted' : 'btn btn-mute';

        if (this.onMuteToggle) {
          this.onMuteToggle(babyId, mute);
        }
      }
    }
  }

  /**
   * Update baby count display
   */
  updateBabyCount() {
    const countElement = document.getElementById('babyCount');
    if (countElement) {
      const count = this.babyCards.size;
      countElement.textContent = `${count} ${count === 1 ? 'baby' : 'babies'} connected`;
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Inject CSS styles
   */
  injectStyles() {
    if (document.getElementById('multi-baby-styles')) return;

    const style = document.createElement('style');
    style.id = 'multi-baby-styles';
    style.textContent = `
      .master-controls {
        background: #fff;
        padding: 1.5em;
        margin-bottom: 1.5em;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }

      .master-controls h2 {
        margin: 0 0 1em 0;
        color: #333;
      }

      .master-buttons {
        display: flex;
        gap: 1em;
        margin-bottom: 1em;
      }

      .master-status {
        font-size: 1.1em;
        color: #666;
      }

      .babies-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
        gap: 1.5em;
        margin-bottom: 2em;
      }

      .baby-card {
        background: #fff;
        border-radius: 8px;
        padding: 1.5em;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        transition: box-shadow 0.3s;
      }

      .baby-card:hover {
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      }

      .baby-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1em;
        padding-bottom: 0.5em;
        border-bottom: 2px solid #f0f0f0;
      }

      .baby-name {
        margin: 0;
        font-size: 1.3em;
        color: #333;
      }

      .baby-status {
        padding: 0.4em 0.8em;
        border-radius: 20px;
        font-size: 0.9em;
        font-weight: bold;
        background: #e8f5e9;
        color: #2e7d32;
      }

      .baby-status.status-error {
        background: #ffebee;
        color: #c62828;
      }

      .baby-status.status-alert {
        background: #fff3e0;
        color: #e65100;
      }

      .baby-status.pulsing {
        animation: pulse-alert 1s ease-in-out infinite;
      }

      @keyframes pulse-alert {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }

      .audio-visualization {
        margin: 1em 0;
      }

      .volume-meter-container {
        height: 30px;
        background: #f0f0f0;
        border-radius: 15px;
        overflow: hidden;
        margin-bottom: 0.5em;
      }

      .volume-meter {
        height: 100%;
        background: #4CAF50;
        transition: width 0.1s, background 0.3s;
        border-radius: 15px;
      }

      .audio-level-indicator {
        text-align: center;
        padding: 0.5em;
      }

      .level-badge {
        display: inline-block;
        padding: 0.5em 1em;
        border-radius: 20px;
        font-weight: bold;
        font-size: 1.1em;
      }

      .level-green {
        background: #e8f5e9;
        color: #2e7d32;
      }

      .level-yellow {
        background: #fff3e0;
        color: #e65100;
      }

      .level-red {
        background: #ffebee;
        color: #c62828;
        animation: pulse-badge 1s ease-in-out infinite;
      }

      @keyframes pulse-badge {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.05); }
      }

      .baby-controls {
        display: flex;
        flex-direction: column;
        gap: 0.8em;
        margin: 1em 0;
      }

      .baby-controls button {
        padding: 0.8em;
        font-size: 1em;
        font-weight: bold;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.3s;
      }

      .btn-mute {
        background: #4CAF50;
        color: white;
      }

      .btn-mute.muted {
        background: #f44336;
      }

      .btn-solo {
        background: #2196F3;
        color: white;
      }

      .btn:hover {
        opacity: 0.9;
        transform: translateY(-2px);
      }

      .volume-control {
        display: flex;
        align-items: center;
        gap: 0.5em;
      }

      .volume-control input[type="range"] {
        flex: 1;
      }

      .sensitivity-control {
        display: flex;
        align-items: center;
        gap: 0.5em;
      }

      .sensitivity-control label {
        cursor: help;
      }

      .sensitivity-control input[type="range"] {
        flex: 1;
      }

      .baby-activity-log {
        margin-top: 1em;
        padding-top: 1em;
        border-top: 1px solid #f0f0f0;
      }

      .baby-activity-log strong {
        display: block;
        margin-bottom: 0.5em;
        color: #666;
      }

      .log-entries {
        max-height: 150px;
        overflow-y: auto;
        font-size: 0.9em;
      }

      .log-entry {
        padding: 0.3em 0;
        border-bottom: 1px solid #f5f5f5;
      }

      .log-time {
        color: #999;
        font-size: 0.85em;
        margin-right: 0.5em;
      }

      .log-success { color: #2e7d32; }
      .log-error { color: #c62828; }
      .log-alert { color: #e65100; }
      .log-info { color: #666; }

      @media (max-width: 768px) {
        .babies-grid {
          grid-template-columns: 1fr;
        }

        .master-buttons {
          flex-direction: column;
        }
      }
    `;

    document.head.appendChild(style);
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiBabyUI;
}
