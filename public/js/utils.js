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

    // Drop into the segmented control cluster (right of the language switcher);
    // fall back to the passed container.
    const host = document.querySelector('.controls-cluster') || container;
    if (host) {
      host.appendChild(btn);
    }

    return btn;
  }
};

// Initialize theme on load
ThemeManager.init();

// Footer legal links (Impressum / Datenschutz) — injected only when the server
// reports them configured (config/legal.json). Keeps the default footer clean
// and the repo free of personal data.
(function () {
  function inject() {
    fetch('/api/legal', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (l) {
        if (!l || (!l.impressum && !l.datenschutz)) return;
        var nav = document.querySelector('.footer-actions');
        if (!nav) return;
        function add(href, key, fallback) {
          var a = document.createElement('a');
          a.className = 'footer-legal-link';
          a.href = href;
          a.setAttribute('data-i18n', key);
          a.textContent = window.i18n ? window.i18n.t(key) : fallback;
          nav.insertBefore(a, nav.firstChild);
        }
        if (l.datenschutz) add('/datenschutz', 'footer_datenschutz', 'Datenschutz');
        if (l.impressum) add('/impressum', 'footer_impressum', 'Impressum');
        if (window.i18n) window.i18n.apply(nav);
      })
      .catch(function () {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
