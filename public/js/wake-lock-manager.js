/**
 * Wake Lock Manager - prevents screen from turning off during monitoring
 */
const _wlT = (k) => (window.i18n ? window.i18n.t(k) : k);

class WakeLockManager {
  constructor() {
    this.wakeLock = null;
    this.supported = 'wakeLock' in navigator;
    this._lastBtnKey = null;
    this._lastBtnDisabled = false;
    // Re-render in the new language when the user switches it.
    document.addEventListener('i18n:changed', () => {
      this.updateUI(!!this.wakeLock, this._lastBtnKey, this._lastBtnDisabled);
    });
  }

  async request() {
    try {
      if (!this.supported) {
        console.warn('Wake Lock API not supported');
        this.updateUI(false, 'mon_not_supported', true);
        return false;
      }
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('Screen Wake Lock acquired');
      this.updateUI(true);
      this.wakeLock.addEventListener('release', () => {
        console.log('Screen Wake Lock released');
        this.updateUI(false);
        this.wakeLock = null;
      });
      return true;
    } catch (err) {
      console.error('Failed to acquire wake lock:', err);
      this.updateUI(false);
      return false;
    }
  }

  release() {
    if (this.wakeLock) {
      this.wakeLock.release();
      this.wakeLock = null;
      this.updateUI(false);
    }
  }

  autoRequest() {
    if (!this.wakeLock && this.supported) {
      this.request();
    }
  }

  // btnKey: locale key for the button label when inactive (default Enable).
  updateUI(active, btnKey, btnDisabled) {
    this._lastBtnKey = btnKey || null;
    this._lastBtnDisabled = !!btnDisabled;
    const indicator = document.getElementById('wakeLockIndicator');
    const button = document.getElementById('wakeLockBtn');
    if (!indicator || !button) return;
    // Rendered here (with an icon), so i18n.apply() must not overwrite it.
    indicator.removeAttribute('data-i18n');
    button.removeAttribute('data-i18n');

    // Drop the surrounding container's classes when we swap (we want
    // .wake-lock-btn to survive across re-renders so the row stays
    // compact).
    if (active) {
      indicator.textContent = '\uD83D\uDD12 ' + _wlT('mon_screenlock_active');
      indicator.className = 'wake-lock-indicator wake-lock-active';
      button.textContent = _wlT('mon_release');
      button.className = 'btn btn-danger wake-lock-btn';
    } else {
      indicator.textContent = '\uD83D\uDCF1 ' + _wlT('mon_screenlock_inactive');
      indicator.className = 'wake-lock-indicator wake-lock-inactive';
      button.textContent = _wlT(btnKey || 'mon_enable');
      button.className = 'btn btn-success wake-lock-btn';
      button.disabled = !!btnDisabled;
    }
  }

  bindEvents(role) {
    const btn = document.getElementById('wakeLockBtn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (this.wakeLock) {
          this.release();
        } else {
          btn.disabled = true;
          btn.textContent = '…';
          const ok = await this.request();
          if (!ok) { btn.disabled = false; btn.textContent = _wlT('mon_retry'); }
        }
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.wakeLock) {
        this.release();
      } else if (!document.hidden && !this.wakeLock && (role === 'parent' || role === 'baby')) {
        setTimeout(() => this.autoRequest(), 1000);
      }
    });

    window.addEventListener('beforeunload', () => this.release());
    this.updateUI(false);
  }
}
