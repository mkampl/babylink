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
