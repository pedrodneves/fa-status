/*
 * Featured App Status: theme.js
 *
 * Loaded in <head> without "defer", so it runs before the page paints. If the
 * visitor picked a theme with the header button (status.js stores it), it
 * sets <html data-theme="light|dark">; otherwise the page follows the
 * system setting (prefers-color-scheme in styles.css). Storage can be
 * unavailable (private windows, blocked site data): then nothing is set.
 */
(function () {
  'use strict';
  try {
    var saved = window.localStorage.getItem('fa-status-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (err) {
    // No storage: follow the system setting.
  }
})();
