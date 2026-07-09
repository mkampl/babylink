// Home page: room create/join, onboarding wizard, PWA install.
// Externalized from views/index.html so it complies with the strict CSP
// (script-src 'self' blocks inline scripts). Loaded after utils.js +
// qrcode-generator.js, which it depends on.

    // Dark mode toggle. Guarded: if utils.js failed to load (flaky mobile
    // network, stale service worker), a ReferenceError here must NOT abort the
    // rest of the script — otherwise the create/join form handlers below never
    // attach and clicking "Create Room" does a native form submit that just
    // reloads the start page.
    try {
      ThemeManager.createToggleButton(document.body);
    } catch (e) {
      console.warn('Theme toggle init failed (non-fatal):', e);
    }

    // ========================
    // Onboarding wizard
    // ========================

    let onboardingStep = 0;
    let onboardingRoomId = null;
    let onboardingRoomName = null;

    function isOnboardingComplete() {
      if (localStorage.getItem('babylink-onboarding-complete') === 'true') return true;
      // Returning users (rooms already saved) skip onboarding even if
      // the completion flag itself got wiped.
      try {
        var rooms = JSON.parse(localStorage.getItem('babylink-rooms') || '[]');
        if (rooms.length > 0) {
          localStorage.setItem('babylink-onboarding-complete', 'true');
          return true;
        }
      } catch (e) {}
      return false;
    }

    function showOnboarding() {
      var dlg = document.getElementById('onboarding');
      goToStep(0);
      if (typeof dlg.showModal === 'function') {
        dlg.showModal();
      } else {
        // Ancient browser fallback — show as a plain block (no focus
        // trap, but at least the wizard is reachable).
        dlg.setAttribute('open', '');
      }
    }

    function hideOnboarding() {
      var dlg = document.getElementById('onboarding');
      if (typeof dlg.close === 'function' && dlg.open) {
        dlg.close();
      } else {
        dlg.removeAttribute('open');
      }
    }

    // Block Escape-to-dismiss — the wizard collects state that would
    // be lost on early cancel. Users with a finished setup never see
    // the dialog; users mid-flow can still use the Back button.
    document.getElementById('onboarding').addEventListener('cancel', function(e) {
      e.preventDefault();
    });

    function goToStep(step) {
      onboardingStep = step;
      document.querySelectorAll('.onboarding-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === step);
      });
      document.querySelectorAll('.onboarding-progress .dot').forEach(el => {
        const dotStep = parseInt(el.dataset.step);
        el.classList.toggle('active', dotStep === step);
        el.classList.toggle('completed', dotStep < step);
      });
    }

    function onboardingNext() {
      goToStep(onboardingStep + 1);
    }

    function onboardingBack() {
      if (onboardingStep > 0) goToStep(onboardingStep - 1);
    }

    function onboardingFinish() {
      localStorage.setItem('babylink-onboarding-complete', 'true');
      if (onboardingRoomId) {
        window.location.href = '/' + encodeURIComponent(onboardingRoomId);
      } else {
        hideOnboarding();
        displayPreviousRooms();
      }
    }

    function onboardingSkip() {
      localStorage.setItem('babylink-onboarding-complete', 'true');
      hideOnboarding();
      displayPreviousRooms();
    }

    function replayOnboarding() {
      showOnboarding();
    }

    // Onboarding room form — create room via server so we get a server-issued
    // roomId and ownerToken (required for management actions).
    document.getElementById('onboardingRoomForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      onboardingRoomName = document.getElementById('onboardingRoomName').value.trim();
      if (!onboardingRoomName) return;

      const submitBtn = this.querySelector('[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';

      try {
        const res = await createRoom(onboardingRoomName);
        onboardingRoomId = res.roomId;
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Room';
        alert('Could not create room: ' + err.message);
        return;
      }

      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Room';

      // Set up step 2 with room link + QR
      var roomUrl = window.location.origin + '/' + onboardingRoomId;
      document.getElementById('onboardingRoomLink').value = roomUrl;

      // QR code rendered locally — no third-party fetch.
      try {
        var qr = qrcode(0, 'M');
        qr.addData(roomUrl);
        qr.make();
        var qrImg = document.getElementById('onboardingQR');
        qrImg.src = qr.createDataURL(6, 4);
        qrImg.alt = 'QR Code for room link';
      } catch (e) {
        document.getElementById('onboardingQR').style.display = 'none';
      }

      goToStep(2);
    });

    // Onboarding copy button
    document.getElementById('onboardingCopyBtn').addEventListener('click', async function() {
      var linkInput = document.getElementById('onboardingRoomLink');
      try {
        await navigator.clipboard.writeText(linkInput.value);
        this.textContent = 'Copied!';
        this.style.background = 'var(--color-success)';
        var btn = this;
        setTimeout(function() { btn.textContent = 'Copy'; btn.style.background = ''; }, 2000);
      } catch (err) {
        linkInput.select();
        document.execCommand('copy');
      }
    });

    // Show onboarding or home. Guarded: a <dialog>.showModal() failure on some
    // mobile browsers must not abort the script (same reason as above — the
    // form handlers further down must still attach).
    try {
      if (!isOnboardingComplete()) {
        showOnboarding();
      }
    } catch (e) {
      console.warn('Onboarding init failed (non-fatal):', e);
    }

    // ========================
    // PWA
    // ========================

    let deferredPrompt;

    // ========================
    // Room auth — creation, ownerToken, saved rooms
    // ========================

    /**
     * Create a room on the server. Returns { roomId, ownerToken }.
     * Saves the ownerToken to localStorage so management actions can
     * attach Authorization: Bearer <ownerToken>.
     */
    async function createRoom(name) {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Server error ' + res.status);
      }
      const data = await res.json();
      if (!data.roomId) throw new Error('Server did not return a roomId');
      // Persist the ownerToken under the canonical key so select-role.html
      // can find it and show management controls to this device only.
      if (data.ownerToken) {
        localStorage.setItem('babylink-owner-' + data.roomId, data.ownerToken);
      }
      saveRoom(name || 'Room', data.roomId, data.ownerToken);
      return data;
    }

    // Room storage — includes ownerToken so a returning owner keeps rights
    function saveRoom(name, id, ownerToken) {
      const rooms = JSON.parse(localStorage.getItem('babylink-rooms') || '[]');
      const existingIndex = rooms.findIndex(room => room.id === id);
      const entry = { name, id, lastUsed: Date.now() };
      // Keep ownerToken in the record as a convenience backup; the canonical
      // copy is under babylink-owner-<roomId>.
      if (ownerToken) entry.ownerToken = ownerToken;

      if (existingIndex >= 0) {
        rooms[existingIndex] = entry;
      } else {
        rooms.push(entry);
      }

      rooms.sort((a, b) => b.lastUsed - a.lastUsed);
      localStorage.setItem('babylink-rooms', JSON.stringify(rooms.slice(0, 10)));
      displayPreviousRooms();
    }

    function deleteRoom(id) {
      const rooms = JSON.parse(localStorage.getItem('babylink-rooms') || '[]');
      const target = rooms.find(r => r.id === id);
      const label = target ? '"' + target.name + '"' : 'this room';
      if (!confirm('Remove ' + label + ' from this device?\n\nThe room itself keeps running for anyone with the link.')) return;
      const filteredRooms = rooms.filter(room => room.id !== id);
      localStorage.setItem('babylink-rooms', JSON.stringify(filteredRooms));
      // Leave the ownerToken in localStorage — the user may want to re-add the room later.
      displayPreviousRooms();
    }

    function displayPreviousRooms() {
      const rooms = JSON.parse(localStorage.getItem('babylink-rooms') || '[]');
      const roomsList = document.getElementById('roomsList');
      const section = document.getElementById('previousRoomsSection');

      if (rooms.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'block';
      roomsList.innerHTML = '';

      // Build rows with DOM methods — room.name and room.id are user-supplied
      // and must never be interpolated into innerHTML or onclick strings.
      rooms.forEach(room => {
        const roomDiv = document.createElement('div');
        roomDiv.className = 'room-item';

        const infoDiv = document.createElement('div');

        const nameDiv = document.createElement('div');
        nameDiv.className = 'room-name';
        nameDiv.textContent = room.name;

        const idDiv = document.createElement('div');
        idDiv.className = 'room-id';
        idDiv.textContent = 'ID: ' + room.id.substring(0, 8) + '...';

        infoDiv.appendChild(nameDiv);
        infoDiv.appendChild(idDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'room-actions';

        const joinBtn = document.createElement('button');
        joinBtn.className = 'join-btn';
        joinBtn.textContent = 'Join';
        joinBtn.addEventListener('click', () => joinRoom(room.id));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => deleteRoom(room.id));

        actionsDiv.appendChild(joinBtn);
        actionsDiv.appendChild(deleteBtn);
        roomDiv.appendChild(infoDiv);
        roomDiv.appendChild(actionsDiv);
        roomsList.appendChild(roomDiv);
      });
    }

    function joinRoom(roomId) {
      window.location.href = "/" + encodeURIComponent(roomId);
    }

    // PWA Install Banner
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showInstallBanner();
    });

    function showInstallBanner() {
      const banner = document.getElementById('pwaInstallBanner');
      banner.style.display = 'block';
    }

    document.getElementById('installPwaBtn').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          console.log('PWA installed');
        }
        deferredPrompt = null;
        document.getElementById('pwaInstallBanner').style.display = 'none';
      }
    });

    document.getElementById('dismissPwaBtn').addEventListener('click', () => {
      document.getElementById('pwaInstallBanner').style.display = 'none';
      // Don't show again for this session
      deferredPrompt = null;
    });

    // Service Worker Registration
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js')
        .then((registration) => {
          console.log('SW registered: ', registration);
        })
        .catch((registrationError) => {
          console.log('SW registration failed: ', registrationError);
        });
    }

    // Form handlers
    document.getElementById("createRoomForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      const roomName = document.getElementById("roomName").value.trim();
      if (!roomName) return;
      const btn = this.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const data = await createRoom(roomName);
        window.location.href = "/" + encodeURIComponent(data.roomId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Create Room';
        alert('Could not create room: ' + err.message);
      }
    });

    document.getElementById("joinRoomForm").addEventListener("submit", function (e) {
      e.preventDefault();
      const rawId = document.getElementById("roomId").value.trim();
      if (!rawId) return;
      // Room IDs are server-issued hex strings (32 hex chars = 16 bytes).
      // Validate before navigating so the user gets a helpful inline error
      // instead of a dead-end JSON 404.
      const errorEl = document.getElementById('joinRoomError');
      if (!/^[0-9a-f]{32}$/i.test(rawId)) {
        if (errorEl) {
          errorEl.textContent = 'Room IDs are 32 hex characters (the part after the last "/" in a shared link).';
          errorEl.hidden = false;
        }
        return;
      }
      if (errorEl) errorEl.hidden = true;
      window.location.href = "/" + encodeURIComponent(rawId);
    });

    // Initialize
    displayPreviousRooms();

// Onboarding button handlers — wired here instead of inline onclick= because
// the CSP (script-src-attr 'none') blocks inline event-handler attributes.
(function wireOnboardingButtons() {
  var map = [
    ['obGetStarted', onboardingNext],
    ['obSkip', onboardingSkip],
    ['obBack', onboardingBack],
    ['obFinish', onboardingFinish],
    ['helpBtn', replayOnboarding]
  ];
  map.forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (el) el.addEventListener('click', pair[1]);
  });
})();
