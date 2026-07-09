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
    this.connectionState = new Map(); // babyId → 'ok' | 'stalled' (set by the audio-health watchdog)

    this.onMuteToggle = null;
    this.onSoloToggle = null;
    this.onVolumeChange = null;
    this.onSensitivityChange = null;
    // Fires every time the audio level for a baby updates (either WebRTC
    // analyser or WSS-PCM analyser). app.js wires this to the per-baby
    // SleepTracker so the tracker sees a continuous volume stream
    // regardless of where it came from.
    this.onLevelObserved = null;

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
    // Styles are loaded via external CSS files (css/components.css)
  }

  /**
   * Create master controls for all babies
   */
  createMasterControls() {
    const masterControls = document.createElement('div');
    masterControls.className = 'master-controls';
    masterControls.innerHTML = `
      <div class="master-title">
        <h2>👶 Baby Monitors</h2>
        <span id="babyCount" class="master-status">0 connected</span>
      </div>
      <div class="master-buttons">
        <button id="muteAllBtn" class="btn btn-danger" title="Mute all">🔇</button>
        <button id="unmuteAllBtn" class="btn btn-success" title="Unmute all">🔊</button>
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
        <span class="baby-status-dot status-ok" id="status-${babyId}" title="Connected" role="status">
          <span class="visually-hidden" id="status-text-${babyId}">Connected</span>
        </span>
        <div class="volume-meter-container">
          <div class="volume-meter" id="meter-${babyId}" style="width: 0%"></div>
        </div>
        <div class="audio-level-indicator" id="level-${babyId}">
          <span class="level-badge level-green">Quiet</span>
        </div>
      </div>

      <div class="baby-controls">
        <button class="btn btn-mute" id="mute-${babyId}" data-muted="true" aria-pressed="true">
          🔇 <span class="btn-label">Muted</span>
        </button>
        <button class="btn btn-solo" id="solo-${babyId}" title="Listen to only this baby" aria-pressed="false">
          🎧 <span class="btn-label">Solo</span>
        </button>
        <button class="btn btn-settings" id="settings-${babyId}" title="Volume &amp; sensitivity"
                aria-label="Volume and sensitivity" aria-expanded="false" aria-controls="advanced-${babyId}">⚙</button>
      </div>
      <!-- Full-width panel below the button row. Toggled by the gear via a JS
           class (no :has() / <details> nesting, which mislaid the panel and
           broke on old browsers). -->
      <div class="advanced-panel" id="advanced-${babyId}" hidden>
        <div class="volume-control">
          <label for="volume-${babyId}">Volume:</label>
          <input type="range" id="volume-${babyId}" min="0" max="100" value="100"
                 aria-label="Volume for ${this.escapeHtml(babyName)}" />
          <span id="volume-value-${babyId}" aria-live="polite">100%</span>
        </div>
        <div class="sensitivity-control">
          <label for="sensitivity-${babyId}" title="Adjust sensitivity for different microphones and room noise levels">Sensitivity:</label>
          <input type="range" id="sensitivity-${babyId}" min="50" max="300" value="100" step="10"
                 aria-label="Sensitivity for ${this.escapeHtml(babyName)}" />
          <span id="sensitivity-value-${babyId}" aria-live="polite">1.0x</span>
        </div>
      </div>

      <details class="baby-sleep-timeline" id="sleep-${babyId}" open>
        <summary class="sleep-summary-line">
          <span class="sleep-label">Sleep</span>
          <span class="sleep-summary" id="sleep-summary-${babyId}"></span>
        </summary>
        <div class="sleep-bars">
          <div class="sleep-detail-label">Last 15 min (15 s slots)</div>
          <div class="sleep-timeline-bar sleep-detail-bar" id="sleep-detail-${babyId}"></div>
          <svg class="sleep-connector" viewBox="0 0 100 12" preserveAspectRatio="none">
            <!-- Trapezoid connecting the full detail bar to the rightmost
                 2.08% (15 min / 720 min) of the history bar below. -->
            <polygon class="sleep-connector-shape"
                     points="0,0 100,0 100,12 97.92,12" />
          </svg>
          <div class="sleep-history-label">Last 12 h (1 min slots)</div>
          <div class="sleep-timeline-bar sleep-history-bar" id="sleep-history-${babyId}"></div>
        </div>
      </details>

      <details class="baby-activity-log" id="log-${babyId}">
        <summary class="log-summary-line">
          <span class="log-label">Activity</span>
          <span class="log-latest" id="log-latest-${babyId}">—</span>
        </summary>
        <div class="log-entries" id="log-entries-${babyId}"></div>
      </details>
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

    // Settings gear — toggles the full-width advanced panel below the row.
    const settingsBtn = document.getElementById(`settings-${babyId}`);
    const advancedPanel = document.getElementById(`advanced-${babyId}`);
    if (settingsBtn && advancedPanel) {
      settingsBtn.addEventListener('click', () => {
        const open = advancedPanel.hasAttribute('hidden');
        if (open) advancedPanel.removeAttribute('hidden');
        else advancedPanel.setAttribute('hidden', '');
        settingsBtn.setAttribute('aria-expanded', String(open));
        settingsBtn.classList.toggle('active', open);
      });
    }

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
   * Set the audio-health connection state for a baby ('ok' | 'stalled').
   * Called by the 1 s watchdog in app.js; rendered by updateAudioLevel so the
   * status dot has a single writer. 'stalled' surfaces "No audio — reconnecting".
   */
  setConnectionState(babyId, state) {
    this.connectionState.set(babyId, state);
  }

  /**
   * Update audio level for a specific baby
   */
  updateAudioLevel(babyId, level, volume) {
    if (this.onLevelObserved) {
      try { this.onLevelObserved(babyId, level, volume); } catch (e) {}
    }
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

    // Status indicator is a small coloured dot now (compact header layout).
    // Honesty first: if the audio-health watchdog flagged this baby as stalled
    // (no audio arriving on either path), show that instead of a falsely-green
    // "Connected" — a wedged tunnel must never look like a calm baby. This is
    // the single writer of the status dot, so the 100 ms level updates and the
    // 1 s watchdog never fight.
    const status = document.getElementById(`status-${babyId}`);
    const statusText = document.getElementById(`status-text-${babyId}`);
    if (status && this.connectionState.get(babyId) === 'stalled') {
      status.className = 'baby-status-dot status-error pulsing';
      status.title = 'No audio';
      if (statusText) statusText.textContent = 'No audio — reconnecting…';
    } else if (status && level === 'RED') {
      status.className = 'baby-status-dot status-alert pulsing';
      status.title = 'Crying';
      if (statusText) statusText.textContent = 'Crying';
    } else if (status) {
      status.className = 'baby-status-dot status-ok';
      status.title = 'Connected';
      if (statusText) statusText.textContent = 'Connected';
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

    // Update button state — preserve the inner .btn-label span so
     // the compact icon-forward layout stays intact.
    const muteBtn = document.getElementById(`mute-${babyId}`);
    if (muteBtn) {
      muteBtn.dataset.muted = 'true';
      muteBtn.setAttribute('aria-pressed', 'true');
      muteBtn.innerHTML = '🔇 <span class="btn-label">Muted</span>';
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

    const muteBtn = document.getElementById(`mute-${babyId}`);
    if (muteBtn) {
      muteBtn.dataset.muted = 'false';
      muteBtn.setAttribute('aria-pressed', 'false');
      muteBtn.innerHTML = '🔊 <span class="btn-label">Unmuted</span>';
      muteBtn.className = 'btn btn-mute';
    }
  }

  /**
   * Update baby connection status
   */
  updateBabyStatus(babyId, connected, reason = '') {
    const status = document.getElementById(`status-${babyId}`);
    const statusText = document.getElementById(`status-text-${babyId}`);
    if (!status) return;
    if (connected) {
      status.className = 'baby-status-dot status-ok';
      status.title = 'Connected';
      if (statusText) statusText.textContent = 'Connected';
    } else {
      status.className = 'baby-status-dot status-error';
      const label = reason ? `Disconnected: ${reason}` : 'Disconnected';
      status.title = label;
      if (statusText) statusText.textContent = label;
      this.logActivity(babyId, `Disconnected: ${reason}`, 'error');
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

    // Mirror the latest entry into the collapsed activity-log summary so
    // important alerts stay visible without expanding the panel.
    const latest = document.getElementById(`log-latest-${babyId}`);
    if (latest) {
      latest.textContent = `${timestamp} — ${message}`;
      latest.className = `log-latest log-${type}`;
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
        muteBtn.setAttribute('aria-pressed', String(mute));
        muteBtn.innerHTML = mute
          ? '🔇 <span class="btn-label">Muted</span>'
          : '🔊 <span class="btn-label">Unmuted</span>';
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
      countElement.textContent = `· ${count} connected`;
    }
  }

  /**
   * Escape HTML to prevent XSS - delegates to global escapeHtml from utils.js
   */
  escapeHtml(text) {
    return escapeHtml(text);
  }

  // Re-render both bars + summary for the baby from the SleepTracker's
  // current aggregates. Caller drives this on a 5 s interval so the
  // detail bar slides smoothly without rebuilding on every observe().
  renderSleepTimeline(babyId, tracker) {
    var detailBar  = document.getElementById('sleep-detail-' + babyId);
    var historyBar = document.getElementById('sleep-history-' + babyId);
    var summaryEl  = document.getElementById('sleep-summary-' + babyId);
    if (!detailBar || !historyBar || !summaryEl || !tracker) return;

    var detailWindowMs  = 15 * 60 * 1000;       // last 15 min
    var detailSlotMs    = 15 * 1000;            // 15 s slots → 60 stripes
    var historyWindowMs = 12 * 60 * 60 * 1000;  // last 12 h
    var historySlotMs   = 60 * 1000;            // 1 min slots → 720 stripes

    this._renderTimelineBar(detailBar, tracker.getSlots(detailWindowMs, detailSlotMs));
    this._renderTimelineBar(historyBar, tracker.getSlots(historyWindowMs, historySlotMs));

    var sum = tracker.getSummary(historyWindowMs);
    var wakes = tracker.getWakeCount(historyWindowMs);
    var sleepHours = Math.floor(sum.greenSecs / 3600);
    var sleepMins  = Math.floor((sum.greenSecs % 3600) / 60);
    var text = sleepHours + 'h ' + sleepMins + 'min quiet';
    if (wakes > 0) text += ', woke ' + wakes + ' time' + (wakes > 1 ? 's' : '');
    summaryEl.textContent = text;
  }

  _renderTimelineBar(barEl, slots) {
    if (!slots.length) { barEl.innerHTML = ''; return; }
    var totalMs = slots[slots.length - 1].endMs - slots[0].startMs;
    var startMs = slots[0].startMs;
    var html = '';
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      var pctLeft  = ((s.startMs - startMs) / totalMs) * 100;
      var pctWidth = ((s.endMs - s.startMs) / totalMs) * 100;
      var cls;
      if (!s.hasData)              cls = 'sleep-empty';
      else if (s.dominant === 'r') cls = 'sleep-red';
      else if (s.dominant === 'y') cls = 'sleep-yellow';
      else                          cls = 'sleep-green';
      html += '<div class="sleep-segment ' + cls + '" style="left:' +
              pctLeft.toFixed(3) + '%;width:' + pctWidth.toFixed(3) + '%;"></div>';
    }
    barEl.innerHTML = html;
  }

}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MultiBabyUI;
}
