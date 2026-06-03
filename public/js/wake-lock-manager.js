/**
 * Wake Lock Manager - prevents screen from turning off during monitoring
 */
class WakeLockManager {
  constructor() {
    this.wakeLock = null;
    this.supported = 'wakeLock' in navigator;
  }

  async request() {
    try {
      if (!this.supported) {
        console.warn('Wake Lock API not supported');
        this.updateUI(false, 'Not Supported', true);
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

  updateUI(active, btnText, btnDisabled) {
    const indicator = document.getElementById('wakeLockIndicator');
    const button = document.getElementById('wakeLockBtn');
    if (!indicator || !button) return;

    // Drop the surrounding container's classes when we swap (we want
    // .wake-lock-btn to survive across re-renders so the row stays
    // compact).
    if (active) {
      indicator.textContent = '\uD83D\uDD12 Screen Lock: Active';
      indicator.className = 'wake-lock-indicator wake-lock-active';
      button.textContent = 'Release';
      button.className = 'btn btn-danger wake-lock-btn';
    } else {
      indicator.textContent = '\uD83D\uDCF1 Screen Lock: Inactive';
      indicator.className = 'wake-lock-indicator wake-lock-inactive';
      button.textContent = btnText || 'Enable';
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
          if (!ok) { btn.disabled = false; btn.textContent = 'Retry'; }
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
