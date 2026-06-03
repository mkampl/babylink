// night-mode.js
// Floating night-mode button for the monitor page. Tapping it goes
// fullscreen and switches the body into a dim, almost-black palette
// so the screen stops blinding parents in a dark bedroom. Tap
// anywhere (or press Escape) to exit. Audio keeps playing throughout.
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    if (!document.body.classList.contains('monitor-page')) return;

    var btn = document.createElement('button');
    btn.id = 'nightModeBtn';
    btn.type = 'button';
    btn.className = 'night-mode-fab';
    btn.setAttribute('aria-label', 'Enter night mode');
    btn.title = 'Night mode — dim screen for sleeping rooms';
    btn.textContent = '🌙';
    document.body.appendChild(btn);

    var active = false;

    function enter() {
      document.body.classList.add('night-mode');
      btn.setAttribute('aria-label', 'Exit night mode');
      active = true;
      var root = document.documentElement;
      if (root.requestFullscreen) {
        root.requestFullscreen().catch(function () {});
      }
    }

    function exit() {
      document.body.classList.remove('night-mode');
      btn.setAttribute('aria-label', 'Enter night mode');
      active = false;
      if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (active) exit(); else enter();
    });

    // Tap anywhere else while active exits — large hit area for a
    // half-asleep parent.
    document.addEventListener('click', function (e) {
      if (!active) return;
      if (e.target === btn) return;
      exit();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && active) exit();
    });

    // If the user leaves fullscreen via the browser's own UI, drop
    // night mode too so the chrome reappears intact.
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement && active) {
        document.body.classList.remove('night-mode');
        btn.setAttribute('aria-label', 'Enter night mode');
        active = false;
      }
    });
  });
})();
