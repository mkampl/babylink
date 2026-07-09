// Role selection + BLE provisioning wizard. Externalized from
// views/select-role.html for CSP compliance (script-src 'self').
// Depends on utils.js + qrcode-generator.js (loaded before it).

    // Dark mode toggle
    ThemeManager.createToggleButton(document.body);

    // QR code rendered locally with qrcode-generator (MIT) so the
    // room URL never leaves the device.
    function generateQR(text) {
      const qrImg = document.getElementById('qrcode');
      try {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        qrImg.src = qr.createDataURL(6, 4);
        qrImg.alt = 'QR Code for room link';
        qrImg.title = 'Scan to join BabyLink room';
      } catch (e) {
        qrImg.style.display = 'none';
        const fallback = document.createElement('div');
        fallback.className = 'qr-fallback';
        fallback.textContent = '📱 QR Code unavailable - please share the link above';
        qrImg.parentNode.appendChild(fallback);
      }
    }

    // Initialize page
    function initializePage() {
      const currentUrl = window.location.origin + window.location.pathname;

      // Set room link
      document.getElementById('roomLink').value = currentUrl;

      // Generate QR code
      generateQR(currentUrl);

      // Copy link functionality
      document.getElementById('copyLinkBtn').addEventListener('click', async () => {
        const linkInput = document.getElementById('roomLink');

        try {
          await navigator.clipboard.writeText(linkInput.value);
          const btn = document.getElementById('copyLinkBtn');
          const originalText = btn.textContent;
          btn.textContent = '✅ Copied!';
          btn.style.background = '#28a745';

          setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
          }, 2000);
        } catch (err) {
          // Fallback for older browsers
          linkInput.select();
          document.execCommand('copy');
          alert('Link copied to clipboard!');
        }
      });

      // Baby form submission
      document.getElementById('babyForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const babyName = document.getElementById('babyName').value.trim();
        if (babyName) {
          storeVerifiedPin();
          const url = `${window.location.pathname}?role=baby&userName=${encodeURIComponent(babyName)}`;
          window.location.href = url;
        }
      });

      // Parent form submission
      document.getElementById('parentForm').addEventListener('submit', (e) => {
        e.preventDefault();
        storeVerifiedPin();
        const parentName = document.getElementById('parentName').value.trim() || 'Parent';
        const url = `${window.location.pathname}?role=parent&userName=${encodeURIComponent(parentName)}`;
        window.location.href = url;
      });
    }

    // ========================
    // Room auth / PIN handling
    // ========================

    const roomId = window.location.pathname.slice(1);
    let roomHasPin = false;
    let verifiedPin = null; // Store verified PIN to pass to Socket.IO join

    /**
     * Return the ownerToken for this room, or null if this device is a joiner.
     * The canonical key is babylink-owner-<roomId>; the saved-rooms record
     * carries a backup copy that we also accept.
     */
    function getOwnerToken() {
      const direct = localStorage.getItem('babylink-owner-' + roomId);
      if (direct) return direct;
      // Fallback: check saved-rooms record (populated by index.html createRoom)
      try {
        var rooms = JSON.parse(localStorage.getItem('babylink-rooms') || '[]');
        var entry = rooms.find(function(r) { return r.id === roomId; });
        if (entry && entry.ownerToken) return entry.ownerToken;
      } catch (e) {}
      return null;
    }

    /**
     * Build a fetch options object that includes the Authorization header when
     * this device has an ownerToken. Falls back gracefully if no token exists.
     */
    function ownerFetchOptions(method, body) {
      var opts = { method: method || 'GET', headers: {} };
      var token = getOwnerToken();
      if (token) opts.headers['Authorization'] = 'Bearer ' + token;
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      return opts;
    }

    /**
     * Show a friendly inline message for 401/403/429 instead of a raw error.
     */
    function handleAuthError(status, resultEl) {
      if (!resultEl) return;
      resultEl.style.display = 'block';
      resultEl.className = 'pin-result error';
      if (status === 401 || status === 403) {
        resultEl.textContent = 'Only the room owner can do this. Create the room from this device to gain management access.';
      } else if (status === 429) {
        resultEl.textContent = 'Too many requests — please wait a moment and try again.';
      } else {
        resultEl.textContent = 'Server error (' + status + '). Please try again.';
      }
    }

    async function checkRoomConfig() {
      try {
        const res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/config');
        const data = await res.json();
        roomHasPin = data.hasPin || false;

        if (roomHasPin) {
          document.getElementById('pinSection').style.display = 'block';
          document.getElementById('roleSelection').style.display = 'none';
        } else {
          document.getElementById('pinSection').style.display = 'none';
          document.getElementById('roleSelection').style.display = '';
        }

        // Settings buttons are owner-only — never show to joiners
        if (getOwnerToken()) {
          document.getElementById('roomSettingsToggle').style.display = 'flex';
        }
      } catch (err) {
        // If check fails, show role selection anyway
        console.error('Room config check failed:', err);
      }
    }

    // PIN verify form
    document.getElementById('pinForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var pin = document.getElementById('pinInput').value;

      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/pin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: pin })
        });
        var data = await res.json();

        if (data.valid) {
          verifiedPin = pin;
          document.getElementById('pinSection').style.display = 'none';
          document.getElementById('roleSelection').style.display = '';
          document.getElementById('pinError').style.display = 'none';
          // Only show settings if this device is the owner
          if (getOwnerToken()) {
            document.getElementById('roomSettingsToggle').style.display = 'flex';
          }
        } else {
          document.getElementById('pinError').style.display = 'block';
          document.getElementById('pinInput').value = '';
          document.getElementById('pinInput').focus();
        }
      } catch (err) {
        console.error('PIN verify failed:', err);
      }
    });

    // PIN settings toggle
    document.getElementById('pinSettingsBtn').addEventListener('click', function() {
      var settings = document.getElementById('pinSettings');
      var visible = settings.style.display !== 'none';
      settings.style.display = visible ? 'none' : 'block';
      if (!visible) {
        document.getElementById('ntfySettings').style.display = 'none';
        document.getElementById('devicesSettings').style.display = 'none';
      }

      if (!visible && roomHasPin) {
        document.getElementById('currentPinRow').style.display = 'block';
        document.getElementById('pinSettingsTitle').textContent = 'Change Room PIN';
        document.getElementById('pinSettingsDesc').textContent = 'Enter current PIN and set a new one, or leave new PIN empty to remove.';
      }
    });

    // Notification settings toggle
    document.getElementById('ntfySettingsBtn').addEventListener('click', function() {
      var settings = document.getElementById('ntfySettings');
      var visible = settings.style.display !== 'none';
      settings.style.display = visible ? 'none' : 'block';
      if (!visible) {
        document.getElementById('pinSettings').style.display = 'none';
        document.getElementById('devicesSettings').style.display = 'none';
        loadNtfyConfig();
      }
    });

    // Load ntfy config from server (owner-auth'd)
    async function loadNtfyConfig() {
      try {
        // Use the owner-authenticated endpoint to retrieve full ntfy settings.
        // GET /api/rooms/:id/config returns only { hasPin, ntfyEnabled } (public);
        // detailed settings come from the owner-auth'd ntfy endpoint.
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/ntfy',
                              ownerFetchOptions('GET'));
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          // Not an owner or endpoint not available yet — leave form blank.
          return;
        }
        if (!res.ok) return;
        var config = await res.json();

        var serverEl = document.getElementById('ntfyServer');
        var topicEl = document.getElementById('ntfyTopic');
        var enabledEl = document.getElementById('ntfyEnabled');
        var cryingEl = document.getElementById('notifyOnCrying');
        var disconnectEl = document.getElementById('notifyOnDisconnect');
        var activityEl = document.getElementById('notifyOnActivity');
        var testBtn = document.getElementById('testNotificationBtn');

        if (serverEl) serverEl.value = config.ntfyServer || '';
        if (topicEl) topicEl.value = config.ntfyTopic || '';
        if (enabledEl) enabledEl.checked = config.ntfyEnabled !== false;
        if (cryingEl) cryingEl.checked = config.notifyOnCrying !== false;
        if (disconnectEl) disconnectEl.checked = config.notifyOnDisconnect !== false;
        if (activityEl) activityEl.checked = config.notifyOnActivity || false;
        if (testBtn) testBtn.disabled = !config.ntfyTopic;
      } catch (err) {
        console.error('Failed to load ntfy config:', err);
      }
    }

    // Save ntfy config (owner-auth'd)
    async function saveNtfyConfig(silent) {
      var topic = (document.getElementById('ntfyTopic')?.value || '').trim();
      var resultEl = document.getElementById('ntfyResult');

      if (!topic) {
        if (!silent && resultEl) {
          resultEl.style.display = 'block';
          resultEl.className = 'pin-result error';
          resultEl.textContent = 'Please enter a topic';
        }
        return;
      }

      var ntfyServer = (document.getElementById('ntfyServer')?.value || '').trim() || null;
      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/ntfy',
          ownerFetchOptions('POST', {
            topic: topic,
            ntfyServer: ntfyServer,
            enabled: document.getElementById('ntfyEnabled')?.checked !== false,
            notifyOnCrying: document.getElementById('notifyOnCrying')?.checked !== false,
            notifyOnDisconnect: document.getElementById('notifyOnDisconnect')?.checked !== false,
            notifyOnActivity: document.getElementById('notifyOnActivity')?.checked || false,
          })
        );
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          handleAuthError(res.status, resultEl);
          return;
        }
        if (!res.ok) throw new Error('Failed to save');

        var testBtn = document.getElementById('testNotificationBtn');
        if (testBtn) testBtn.disabled = false;

        if (!silent && resultEl) {
          resultEl.style.display = 'block';
          resultEl.className = 'pin-result success';
          resultEl.textContent = 'Settings saved';
          setTimeout(function() { resultEl.style.display = 'none'; }, 3000);
        }
      } catch (err) {
        console.error('Failed to save ntfy config:', err);
        if (!silent && resultEl) {
          resultEl.style.display = 'block';
          resultEl.className = 'pin-result error';
          resultEl.textContent = 'Failed to save';
        }
      }
    }

    // Ntfy form submit
    document.getElementById('ntfyForm').addEventListener('submit', function(e) {
      e.preventDefault();
      saveNtfyConfig(false);
    });

    // Enable test button when topic is entered
    document.getElementById('ntfyTopic').addEventListener('input', function() {
      document.getElementById('testNotificationBtn').disabled = !this.value.trim();
    });

    // Test notification — auto-saves first (owner-auth'd)
    document.getElementById('testNotificationBtn').addEventListener('click', async function() {
      var btn = this;
      var resultEl = document.getElementById('ntfyResult');
      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        await saveNtfyConfig(true);
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/ntfy/test',
                              ownerFetchOptions('POST'));
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          handleAuthError(res.status, resultEl);
          return;
        }
        if (!res.ok) {
          var data = await res.json().catch(function() { return {}; });
          throw new Error(data.error || 'Failed');
        }
        var result = await res.json();
        if (resultEl) {
          resultEl.style.display = 'block';
          resultEl.className = 'pin-result ' + (result.success ? 'success' : 'error');
          resultEl.textContent = result.success ? 'Test sent! Check your phone.' : 'Failed to send';
          setTimeout(function() { resultEl.style.display = 'none'; }, 5000);
        }
      } catch (err) {
        if (resultEl) {
          resultEl.style.display = 'block';
          resultEl.className = 'pin-result error';
          resultEl.textContent = err.message || 'Error sending';
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });

    // PIN set form (owner-auth'd)
    document.getElementById('pinSetForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var newPin = document.getElementById('newPinInput').value;
      var currentPin = document.getElementById('currentPinInput').value || verifiedPin;
      var resultEl = document.getElementById('pinSetResult');

      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/pin',
          ownerFetchOptions('POST', { pin: newPin || null, currentPin: currentPin }));
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          handleAuthError(res.status, resultEl);
          return;
        }
        var data = await res.json();

        resultEl.style.display = 'block';
        if (res.ok) {
          resultEl.className = 'pin-result success';
          resultEl.textContent = data.message;
          roomHasPin = data.hasPin;
          if (data.hasPin) verifiedPin = newPin;
          else verifiedPin = null;
          document.getElementById('newPinInput').value = '';
          document.getElementById('currentPinInput').value = '';
        } else {
          resultEl.className = 'pin-result error';
          resultEl.textContent = data.error;
        }
      } catch (err) {
        resultEl.style.display = 'block';
        resultEl.className = 'pin-result error';
        resultEl.textContent = 'Failed to update PIN';
      }
    });

    // ========================
    // Devices panel
    // ========================

    var devicesPollingInterval = null;

    document.getElementById('devicesSettingsBtn').addEventListener('click', function() {
      var settings = document.getElementById('devicesSettings');
      var visible = settings.style.display !== 'none';
      settings.style.display = visible ? 'none' : 'block';
      if (!visible) {
        document.getElementById('pinSettings').style.display = 'none';
        document.getElementById('ntfySettings').style.display = 'none';
        loadDevices();
        startDevicePolling();
        // Pre-fill server info — same LAN-aware hint the BLE wizard
        // uses, so the manual setup instructions don't tell the user
        // to type "localhost" into an ESP on a different machine.
        ensureServerHint().then(function(h) {
          document.getElementById('prefillServer').textContent = h.host;
          document.getElementById('prefillPort').textContent = h.port;
          document.getElementById('prefillRoom').textContent = window.location.pathname.slice(1);
        });
        // Show BLE button if Web Bluetooth available; otherwise emphasize
        // the SoftAP manual setup as the primary path (iOS / Safari / desktop).
        var manualHeading = document.getElementById('manualSetupHeading');
        if (navigator.bluetooth) {
          document.getElementById('bleProvisionBtn').style.display = 'block';
          if (manualHeading) manualHeading.textContent = 'Manual Setup (all platforms):';
        } else {
          if (manualHeading) manualHeading.textContent = 'Set up via WiFi (iOS / Safari / desktop):';
        }
      } else {
        stopDevicePolling();
      }
    });

    document.getElementById('addDeviceBtn').addEventListener('click', function() {
      var instructions = document.getElementById('addDeviceInstructions');
      instructions.style.display = instructions.style.display === 'none' ? 'block' : 'none';
    });

    function startDevicePolling() {
      stopDevicePolling();
      devicesPollingInterval = setInterval(loadDevices, 10000);
    }

    function stopDevicePolling() {
      if (devicesPollingInterval) {
        clearInterval(devicesPollingInterval);
        devicesPollingInterval = null;
      }
    }

    async function loadDevices() {
      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/esp32/devices',
                              ownerFetchOptions('GET'));
        if (!res.ok) return;
        var data = await res.json();
        renderDevices(data.devices || []);
      } catch (err) {
        console.error('Failed to load devices:', err);
      }
    }

    function renderDevices(devices) {
      var list = document.getElementById('devicesList');
      var noDevices = document.getElementById('noDevices');

      if (devices.length === 0) {
        list.innerHTML = '';
        noDevices.style.display = 'block';
        return;
      }

      noDevices.style.display = 'none';
      // Build each row with DOM methods so device names (user-settable) and
      // IDs (server-issued hex) are inserted as text — never as raw HTML.
      list.innerHTML = '';
      devices.forEach(function(d) {
        var uptimeMin = Math.floor(d.uptime / 60000);
        var uptimeStr = uptimeMin < 60
          ? uptimeMin + 'min'
          : Math.floor(uptimeMin / 60) + 'h ' + (uptimeMin % 60) + 'min';

        var item = document.createElement('div');
        item.className = 'device-item';

        var dot = document.createElement('div');
        dot.className = 'device-status-dot';
        item.appendChild(dot);

        var info = document.createElement('div');
        info.className = 'device-info';

        var nameRow = document.createElement('div');
        nameRow.className = 'device-name';
        nameRow.textContent = d.name;
        var badge = document.createElement('span');
        badge.className = d.deviceType === 'esp32-s3'
          ? 'device-type-badge device-type-s3' : 'device-type-badge';
        badge.textContent = d.deviceType === 'esp32-s3' ? 'XIAO S3' : 'ESP32';
        nameRow.appendChild(document.createTextNode(' '));
        nameRow.appendChild(badge);
        info.appendChild(nameRow);

        var meta = document.createElement('div');
        meta.className = 'device-meta';
        // clientIp is a server-emitted IP string; audioPacketsReceived is a number.
        // Both are set via textContent to be safe.
        meta.textContent = d.clientIp + ' · ' + uptimeStr + ' · ' + d.audioPacketsReceived + ' packets';
        info.appendChild(meta);
        item.appendChild(info);

        var actions = document.createElement('div');
        actions.className = 'device-actions';

        var renameBtn = document.createElement('button');
        renameBtn.className = 'device-rename-btn';
        renameBtn.textContent = 'Rename';
        renameBtn.addEventListener('click', function() { renameDevice(d.id, d.name); });

        var disconnectBtn = document.createElement('button');
        disconnectBtn.className = 'device-disconnect-btn';
        disconnectBtn.textContent = 'Disconnect';
        disconnectBtn.addEventListener('click', function() { disconnectDevice(d.id); });

        var resetBtn = document.createElement('button');
        resetBtn.className = 'device-reset-btn';
        resetBtn.textContent = 'Reset';
        resetBtn.addEventListener('click', function() { resetDevice(d.id); });

        actions.appendChild(renameBtn);
        actions.appendChild(disconnectBtn);
        actions.appendChild(resetBtn);
        item.appendChild(actions);
        list.appendChild(item);
      });
    }

    window.renameDevice = async function(esp32Id, currentName) {
      var newName = prompt('Device name:', currentName);
      if (!newName || newName === currentName) return;
      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/esp32/' + encodeURIComponent(esp32Id),
          ownerFetchOptions('PATCH', { name: newName }));
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          alert('Only the room owner can rename devices.');
          return;
        }
        loadDevices();
      } catch (err) {
        console.error('Rename failed:', err);
      }
    };

    window.disconnectDevice = async function(esp32Id) {
      if (!confirm('Disconnect this device?\n\nThe device will keep its WiFi + room config and reconnect on next power cycle.')) return;
      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/esp32/' + encodeURIComponent(esp32Id),
          ownerFetchOptions('DELETE'));
        if (res.status === 401 || res.status === 403) {
          alert('Only the room owner can disconnect devices.');
          return;
        }
        loadDevices();
      } catch (err) {
        console.error('Disconnect failed:', err);
      }
    };

    window.resetDevice = async function(esp32Id) {
      if (!confirm('Reset this device to factory defaults?\n\nClears WiFi credentials, server, and room. The device will reboot into provisioning mode (BLE + setup network).')) return;
      try {
        var res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/esp32/' + encodeURIComponent(esp32Id) + '/reset',
          ownerFetchOptions('POST'));
        if (res.status === 401 || res.status === 403) {
          alert('Only the room owner can reset devices.');
          return;
        }
        if (!res.ok) {
          var body = await res.json().catch(function() { return {}; });
          alert('Reset failed: ' + (body.error || res.statusText));
        }
        loadDevices();
      } catch (err) {
        console.error('Reset failed:', err);
      }
    };

    // ========================
    // BLE Provisioning (Web Bluetooth API — Android Chrome only)
    //
    // Three characteristics on the device:
    //   config (R/W JSON blob)   — full multi-profile config
    //   scan   (W "scan" / R [])  — trigger + read WiFi scan results
    //   command (W "apply")       — persist + reboot
    // ========================

    var BLE_SERVICE_UUID = 'bab71111-0002-1000-8000-00805f9b34fb';
    var BLE_CHAR_CONFIG  = 'bab71111-0002-1001-8000-00805f9b34fb';
    var BLE_CHAR_SCAN    = 'bab71111-0002-1002-8000-00805f9b34fb';
    var BLE_CHAR_COMMAND = 'bab71111-0002-1003-8000-00805f9b34fb';
    // Optional — only the S3 firmware exposes this. Classic firmware
    // doesn't have char 1004; we treat read failures as "unknown".
    var BLE_CHAR_INFO    = 'bab71111-0002-1004-8000-00805f9b34fb';

    var bleDevice = null;
    var bleServer = null;
    var bleService = null;
    var bleInfoChar = null;
    // Provisioning gate: a configured device won't accept a config/apply until
    // its BLE window is opened by a physical BOOT-button tap. provOpen tracks
    // that (pushed live via INFO notifications). Older firmware has no gate →
    // treat as always open so it keeps working.
    var bleProvOpen = true;
    var bleConfigured = false;
    var bleConfig = { wifi: [], servers: [], activeServer: 0, deviceName: '' };
    var BLE_MAX_WIFI = 6;
    var BLE_MAX_SERVERS = 4;

    function $(id) { return document.getElementById(id); }

    // Show the "tap the button" prompt and disable Save while a configured
    // device's provisioning window is closed. Called on connect and whenever
    // the device pushes an INFO update (button tap opens the window).
    function updateGateHint() {
      var locked = bleConfigured && !bleProvOpen;
      var hint = $('bleGateHint');
      if (hint) hint.style.display = locked ? 'block' : 'none';
      var save = $('bleSaveBtn');
      if (save) {
        save.disabled = locked;
        save.title = locked ? 'Tap the button on the device to enable changes' : '';
      }
    }

    function renderBleWifi() {
      var host = $('bleWifiRows');
      host.innerHTML = '';
      if (!bleConfig.wifi.length) {
        host.innerHTML = '<div class="ble-empty-state">No WiFi networks yet — scan or add manually.</div>';
        return;
      }
      bleConfig.wifi.forEach(function(p, i) {
        var div = document.createElement('div');
        div.className = 'ble-config-row';
        div.innerHTML =
          '<div class="ble-flex-grow">' +
          '<input type="text" data-i="' + i + '" data-k="ssid" value="' + escapeHtml(p.ssid || '') + '" placeholder="SSID" class="ble-row-input ble-row-input--spaced" />' +
          '<input type="password" data-i="' + i + '" data-k="password" value="' + escapeHtml(p.password || '') + '" placeholder="Password" class="ble-row-input" />' +
          '</div>' +
          '<button type="button" data-rm-w="' + i + '" class="ble-remove-btn">×</button>';
        host.appendChild(div);
      });
    }

    function renderBleServers() {
      var host = $('bleServerRows');
      host.innerHTML = '';
      if (!bleConfig.servers.length) {
        host.innerHTML = '<div class="ble-empty-state">No servers yet.</div>';
        return;
      }
      bleConfig.servers.forEach(function(p, i) {
        var div = document.createElement('div');
        div.className = 'ble-config-row';
        var active = (i === bleConfig.activeServer) ? 'checked' : '';
        div.innerHTML =
          '<div class="ble-flex-grow">' +
          '<input type="text" data-i="' + i + '" data-k="label" value="' + escapeHtml(p.label || '') + '" placeholder="Label (e.g. Home)" class="ble-row-input ble-row-input--spaced" />' +
          '<input type="text" data-i="' + i + '" data-k="host" value="' + escapeHtml(p.host || '') + '" placeholder="Host or IP" class="ble-row-input ble-row-input--spaced" />' +
          '<input type="number" data-i="' + i + '" data-k="port" value="' + (p.port || 3001) + '" placeholder="Port" class="ble-row-input ble-row-input--spaced" />' +
          '<input type="text" data-i="' + i + '" data-k="roomId" value="' + escapeHtml(p.roomId || '') + '" placeholder="Room ID" class="ble-row-input" />' +
          '<label class="ble-active-toggle"><input type="radio" name="ble-active" data-a="' + i + '" ' + active + ' /> Active</label>' +
          '</div>' +
          '<button type="button" data-rm-s="' + i + '" class="ble-remove-btn">×</button>';
        host.appendChild(div);
      });
    }

    function renderBleEditor() {
      renderBleWifi();
      renderBleServers();
      $('bleDevName').value = bleConfig.deviceName || '';
    }

    // 3-step wizard navigation. Each step validates before letting the
    // user move forward; back never validates (so a half-typed entry
    // doesn't trap them). Progress dots get .active on the current,
    // .completed on every step the user has passed validation on.
    var bleWizardStep = 0;

    function bleStepValid(stepIdx) {
      if (stepIdx === 0) {
        var hasWifi = bleConfig.wifi && bleConfig.wifi.some(function(w) {
          return w.ssid && w.ssid.trim().length > 0;
        });
        if (!hasWifi) return 'Add at least one WiFi network.';
      } else if (stepIdx === 1) {
        var hasServer = bleConfig.servers && bleConfig.servers.some(function(s) {
          return s.host && s.host.trim().length > 0 && s.roomId && s.roomId.trim().length > 0;
        });
        if (!hasServer) return 'Add at least one server with host and room ID.';
      }
      return null;
    }

    function goToBleStep(target) {
      bleWizardStep = target;
      document.querySelectorAll('#bleEditor .ble-step').forEach(function(el) {
        el.classList.toggle('active', parseInt(el.dataset.step, 10) === target);
      });
      document.querySelectorAll('#bleProgress .ble-dot').forEach(function(el) {
        var n = parseInt(el.dataset.step, 10);
        el.classList.toggle('active', n === target);
        el.classList.toggle('completed', n < target);
      });
      // Step status messages should reset whenever the user moves —
      // a stale "add at least one server" from step 1 shouldn't shout
      // at them on step 2.
      $('bleStatus').textContent = 'Connected — step ' + (target + 1) + ' of 3';
    }

    document.addEventListener('click', function(e) {
      var nextTo = e.target.getAttribute('data-ble-step-next');
      if (nextTo !== null) {
        var err = bleStepValid(bleWizardStep);
        if (err) {
          $('bleStatus').textContent = err;
          return;
        }
        goToBleStep(parseInt(nextTo, 10));
        return;
      }
      var backTo = e.target.getAttribute('data-ble-step-back');
      if (backTo !== null) {
        goToBleStep(parseInt(backTo, 10));
      }
    });

    // Cached server hint — fetched once from /api/config/server-hint when
    // the wizard opens on a loopback origin, so the ESP gets a LAN
    // address it can actually reach instead of "localhost".
    var cachedServerHint = null;

    async function ensureServerHint() {
      if (cachedServerHint) return cachedServerHint;
      var h = window.location.hostname;
      if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') {
        cachedServerHint = { host: h, port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80) };
        return cachedServerHint;
      }
      try {
        var r = await fetch('/api/config/server-hint');
        var j = await r.json();
        cachedServerHint = { host: j.host, port: j.port };
      } catch (e) {
        cachedServerHint = { host: h, port: window.location.port || 80 };
      }
      return cachedServerHint;
    }

    function defaultServerProfile() {
      var roomId = window.location.pathname.slice(1);
      var hint = cachedServerHint || { host: window.location.hostname, port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80) };
      return {
        label: hint.host,
        host: hint.host,
        port: parseInt(hint.port, 10),
        roomId: roomId
      };
    }

    // Delegate input/click handlers for the dynamically rendered rows
    document.addEventListener('input', function(e) {
      var t = e.target;
      if (!t.dataset || t.dataset.k === undefined) {
        if (t.id === 'bleDevName') bleConfig.deviceName = t.value;
        return;
      }
      var inWifi = !!t.closest('#bleWifiRows');
      var list = inWifi ? bleConfig.wifi : bleConfig.servers;
      var i = parseInt(t.dataset.i, 10);
      if (!list[i]) return;
      list[i][t.dataset.k] = (t.dataset.k === 'port') ? parseInt(t.value || '0', 10) : t.value;
    });
    document.addEventListener('change', function(e) {
      if (e.target.dataset && e.target.dataset.a !== undefined) {
        bleConfig.activeServer = parseInt(e.target.dataset.a, 10);
      }
    });
    document.addEventListener('click', function(e) {
      var t = e.target;
      if (!t.dataset) return;
      if (t.dataset.rmW !== undefined) {
        bleConfig.wifi.splice(parseInt(t.dataset.rmW, 10), 1);
        renderBleWifi();
      } else if (t.dataset.rmS !== undefined) {
        bleConfig.servers.splice(parseInt(t.dataset.rmS, 10), 1);
        if (bleConfig.activeServer >= bleConfig.servers.length) {
          bleConfig.activeServer = Math.max(0, bleConfig.servers.length - 1);
        }
        renderBleServers();
      } else if (t.dataset.pickSsid !== undefined) {
        if (bleConfig.wifi.length >= BLE_MAX_WIFI) return;
        bleConfig.wifi.push({ ssid: t.dataset.pickSsid, password: '' });
        $('bleScanList').innerHTML = '';
        renderBleWifi();
      }
    });

    $('startBleBtn').addEventListener('click', async function() {
      var wizard = $('bleWizard');
      var status = $('bleStatus');
      var result = $('bleResult');

      wizard.style.display = 'block';
      status.textContent = 'Scanning for BabyLink devices…';
      result.style.display = 'none';
      $('bleEditor').style.display = 'none';

      // Pre-fetch the LAN address the server prefers — used by
      // defaultServerProfile() and the empty-config seeder below so a
      // wizard opened on http://localhost still hands the ESP a host
      // it can actually reach.
      await ensureServerHint();

      try {
        bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'BabyLink' }],
          optionalServices: [BLE_SERVICE_UUID]
        });

        status.textContent = 'Connecting to ' + bleDevice.name + '…';
        bleServer = await bleDevice.gatt.connect();
        bleService = await bleServer.getPrimaryService(BLE_SERVICE_UUID);

        // Try to read device_info (new char on S3 firmware) — gives us
        // the hardware model + firmware tag to show in the status line.
        // Classic firmware doesn't expose this; the catch handles that
        // gracefully (we just keep the BLE-advertised name).
        var deviceLabel = bleDevice.name;
        bleProvOpen = true;      // assume open (older firmware has no gate)
        bleConfigured = false;
        bleInfoChar = null;
        try {
          bleInfoChar = await bleService.getCharacteristic(BLE_CHAR_INFO);
          var infoRaw = await bleInfoChar.readValue();
          var info = JSON.parse(new TextDecoder().decode(infoRaw));
          if (info.model) {
            deviceLabel = bleDevice.name + ' (' + info.model +
                          (info.fw ? ' · ' + info.fw : '') + ')';
          }
          // Gate fields exist only on gated firmware; absent → stay "open".
          if (typeof info.provOpen === 'boolean') bleProvOpen = info.provOpen;
          if (typeof info.configured === 'boolean') bleConfigured = info.configured;
          // Live updates when the user taps the device button.
          try {
            await bleInfoChar.startNotifications();
            bleInfoChar.addEventListener('characteristicvaluechanged', function(ev) {
              try {
                var u = JSON.parse(new TextDecoder().decode(ev.target.value));
                if (typeof u.provOpen === 'boolean') bleProvOpen = u.provOpen;
                if (typeof u.configured === 'boolean') bleConfigured = u.configured;
                updateGateHint();
              } catch (e) { /* ignore malformed */ }
            });
          } catch (e) { /* notifications unsupported — fall back to read */ }
        } catch (e) {
          /* older firmware without device_info — fall back to name */
        }

        // Pull current config from device so the editor shows what's saved
        status.textContent = 'Reading current config…';
        try {
          var cfgChar = await bleService.getCharacteristic(BLE_CHAR_CONFIG);
          var raw = await cfgChar.readValue();
          var text = new TextDecoder().decode(raw);
          if (text && text.trim()) {
            var parsed = JSON.parse(text);
            bleConfig = {
              wifi: parsed.wifi || [],
              servers: parsed.servers || [],
              activeServer: parsed.activeServer || 0,
              deviceName: parsed.deviceName || ''
            };
          }
        } catch (e) {
          console.warn('Could not read existing config — starting fresh', e);
          bleConfig = { wifi: [], servers: [], activeServer: 0, deviceName: '' };
        }

        // Pre-seed the current server as active so the device registers
        // here, not against whatever the firmware happened to ship with.
        // Use the LAN hint instead of raw location.hostname so the
        // pre-seeded server entry points the ESP at the host's actual
        // network address, not "localhost".
        var curHost = cachedServerHint ? cachedServerHint.host : window.location.hostname;
        var curPort = cachedServerHint ? parseInt(cachedServerHint.port, 10) : parseInt(window.location.port || (window.location.protocol === 'https:' ? 443 : 80), 10);
        var curRoom = window.location.pathname.slice(1);
        var matchIdx = -1;
        for (var i = 0; i < bleConfig.servers.length; i++) {
          var s = bleConfig.servers[i];
          if (s.host === curHost && (s.port || 3001) === curPort && s.roomId === curRoom) {
            matchIdx = i;
            break;
          }
        }
        if (matchIdx >= 0) {
          bleConfig.activeServer = matchIdx;
        } else {
          bleConfig.servers.unshift({ label: curHost, host: curHost, port: curPort, roomId: curRoom });
          bleConfig.activeServer = 0;
        }

        status.textContent = 'Connected to ' + deviceLabel;
        $('bleEditor').style.display = 'block';
        goToBleStep(0);
        renderBleEditor();
        updateGateHint();
      } catch (err) {
        if (err.name === 'NotFoundError') {
          status.textContent = 'No device selected.';
        } else {
          status.textContent = 'Error: ' + err.message;
        }
        console.error('BLE error:', err);
      }
    });

    $('bleScanBtn').addEventListener('click', async function() {
      var btn = $('bleScanBtn');
      var sl = $('bleScanList');
      if (!bleService) { sl.innerHTML = '<div class="ble-error-text">Not connected.</div>'; return; }
      btn.disabled = true;
      var origLabel = btn.textContent;
      btn.textContent = 'Scanning…';
      sl.innerHTML = '';
      try {
        var scanChar = await bleService.getCharacteristic(BLE_CHAR_SCAN);
        await scanChar.writeValue(new TextEncoder().encode('scan'));
        // Poll for results. WiFi scan with BT coexist takes ~3–7 s on
        // the S3; the fixed-4s wait we had before raced with finished
        // scans, leaving the wizard reading the previous "[]" payload.
        // Re-read every 500 ms until we see a non-empty array or the
        // 12 s ceiling, whichever comes first.
        var list = [];
        var deadline = Date.now() + 12000;
        // First grace period before the first read — the scan hasn't
        // even started populating yet.
        await new Promise(function(r) { setTimeout(r, 1500); });
        while (Date.now() < deadline) {
          var raw = await scanChar.readValue();
          try { list = JSON.parse(new TextDecoder().decode(raw) || '[]'); } catch (_) { list = []; }
          if (list.length) break;
          await new Promise(function(r) { setTimeout(r, 500); });
        }
        if (!list.length) {
          sl.innerHTML = '<div class="ble-help-text">No networks found.</div>';
        } else {
          sl.innerHTML = '<div class="ble-scan-hint">Tap to add:</div>';
          list.sort(function(a, b) { return (b.rssi || -100) - (a.rssi || -100); });
          list.forEach(function(n) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'onboarding-btn secondary ble-scan-chip';
            b.dataset.pickSsid = n.ssid;
            b.textContent = n.ssid + ' (' + n.rssi + ' dBm' + (n.secure ? '' : ' · open') + ')';
            sl.appendChild(b);
          });
        }
      } catch (e) {
        sl.innerHTML = '<div class="ble-error-text">Scan failed: ' + escapeHtml(e.message) + '</div>';
      }
      btn.disabled = false;
      btn.textContent = origLabel;
    });

    $('bleAddWifi').addEventListener('click', function() {
      if (bleConfig.wifi.length >= BLE_MAX_WIFI) return;
      bleConfig.wifi.push({ ssid: '', password: '' });
      renderBleWifi();
    });
    $('bleAddServer').addEventListener('click', function() {
      if (bleConfig.servers.length >= BLE_MAX_SERVERS) return;
      bleConfig.servers.push(defaultServerProfile());
      renderBleServers();
    });

    $('bleSaveBtn').addEventListener('click', async function() {
      var status = $('bleStatus');
      var result = $('bleResult');
      if (!bleService) {
        result.style.display = 'block';
        result.className = 'pin-result error';
        result.textContent = 'Not connected to device';
        return;
      }
      if (!bleConfig.wifi.length || !bleConfig.wifi[0].ssid) {
        alert('Add at least one WiFi network with an SSID.');
        return;
      }
      if (!bleConfig.servers.length || !bleConfig.servers[0].host || !bleConfig.servers[0].roomId) {
        alert('Add at least one server with host and room ID.');
        return;
      }
      // Gate: a configured device rejects writes until its window is opened by
      // a physical button tap. Surface that clearly instead of a silent failure.
      if (bleConfigured && !bleProvOpen) {
        updateGateHint();
        result.style.display = 'block';
        result.className = 'pin-result error';
        result.textContent = 'Locked: tap the button on the device once (LED blinks 3×), then Save.';
        return;
      }
      // The config write must actually succeed — if it fails, no point
      // applying. The apply write, however, intentionally reboots the
      // device, which drops the BLE link mid-write. Catch each separately
      // so an expected post-apply disconnect doesn't surface as "Failed".
      status.textContent = 'Writing configuration…';
      try {
        var blob = JSON.stringify(bleConfig);
        var cfgChar = await bleService.getCharacteristic(BLE_CHAR_CONFIG);
        await cfgChar.writeValue(new TextEncoder().encode(blob));
      } catch (err) {
        status.textContent = 'Connected to ' + (bleDevice ? bleDevice.name : 'device');
        result.style.display = 'block';
        result.className = 'pin-result error';
        result.textContent = 'Failed to write config: ' + err.message;
        console.error('BLE config write error:', err);
        return;
      }

      status.textContent = 'Applying…';
      try {
        var cmdChar = await bleService.getCharacteristic(BLE_CHAR_COMMAND);
        await cmdChar.writeValue(new TextEncoder().encode('apply'));
      } catch (err) {
        // Expected: the device reboots immediately on "apply" and the
        // BLE link drops mid-write. That's success, not failure.
        console.log('Apply write dropped on reboot (expected):', err && err.message);
      }

      status.textContent = '';
      result.style.display = 'block';
      result.className = 'pin-result success';
      result.textContent = 'Configuration sent! Device is restarting; it should appear in the devices list within ~15 seconds.';
      $('bleEditor').style.display = 'none';

      try { if (bleServer && bleServer.connected) bleServer.disconnect(); } catch (e) { /* ignore */ }
      bleDevice = null;
      bleServer = null;
      bleService = null;
    });

    // Store verified PIN in sessionStorage for use by app.js
    function storeVerifiedPin() {
      if (verifiedPin) {
        sessionStorage.setItem('babylink-room-pin', verifiedPin);
      }
    }

    // Service Worker Registration
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(function() {});
    }

    // Initialize when page loads
    document.addEventListener('DOMContentLoaded', function() {
      initializePage();
      checkRoomConfig();
    });
