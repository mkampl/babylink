/**
 * Shared utility functions for BabyLink frontend
 */

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

    // Also listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateIcon);

    if (container) {
      container.appendChild(btn);
    }

    return btn;
  }
};

// Initialize theme on load
ThemeManager.init();
