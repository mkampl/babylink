/**
 * Shared utility functions for BabyLink frontend
 */

/**
 * Escape HTML special characters to prevent XSS.
 * Safe for both element text content and attribute values (escapes all five
 * dangerous characters including single quotes used in onclick= strings).
 */
function escapeHtml(text) {
  if (typeof text !== 'string') text = String(text == null ? '' : text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Dark mode management
 * Supports: system preference auto-detect, manual toggle, localStorage persistence
 */
const ThemeManager = {
  STORAGE_KEY: 'babylink-theme',

  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    }
    // If no saved preference, the CSS @media query handles auto-detect
  },

  toggle() {
    const current = this.getCurrent();
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(this.STORAGE_KEY, next);
    return next;
  },

  getCurrent() {
    const saved = document.documentElement.getAttribute('data-theme');
    if (saved) return saved;
    // Check system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  },

  /**
   * Create and insert a theme toggle button into the page
   */
  createToggleButton(container) {
    const btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', 'Toggle dark mode');
    btn.title = 'Toggle dark/light mode';

    const updateIcon = () => {
      btn.textContent = this.getCurrent() === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
    };

    updateIcon();

    btn.addEventListener('click', () => {
      this.toggle();
      updateIcon();
    });

    // Also listen for system preference changes. Older Safari (iOS < 14)
    // only has the legacy MediaQueryList.addListener — calling the modern
    // addEventListener there throws a TypeError, which previously aborted the
    // whole page script (breaking the Create Room button). Feature-detect.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', updateIcon);
    } else if (mq.addListener) {
      mq.addListener(updateIcon);
    }

    if (container) {
      container.appendChild(btn);
    }

    return btn;
  }
};

// Initialize theme on load
ThemeManager.init();
