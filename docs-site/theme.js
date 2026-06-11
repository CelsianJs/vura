/**
 * Vura Docs — Theme Toggle
 * Dark/light mode with localStorage persistence + system preference detection.
 * Ported from what-fw/docs-site/theme.js; storage key scoped to vura-docs.
 */
(function () {
  const STORAGE_KEY = 'vura-theme';

  function getPreferred() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }

  // Apply immediately (before paint) to avoid flash
  apply(getPreferred());

  function init() {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') || 'dark';
        apply(current === 'dark' ? 'light' : 'dark');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
    if (!localStorage.getItem(STORAGE_KEY)) {
      apply(e.matches ? 'light' : 'dark');
    }
  });
})();
