/**
 * BabyLink App - main orchestrator for the monitoring page.
 * Coordinates all modules: socket, wake lock, alarm, ESP32 audio, notifications.
 */
(function() {
  'use strict';

  // Parse URL params
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role') || 'parent';
  const userName = params.get('userName') || role;
  const roomId = window.location.pathname.slice(1);

  // Shared state
  const socket = io();
  const esp32AudioContexts = new Map();
  let multiStreamManager = null;
  let multiBabyUI = null;
  let localStream = null;
  let hasJoinedRoom = false;
  let isInitialized = false;
  let wasDisconnected = false;
  let webrtcAudioEnabled = false;
  const pendingSignals = []; // Queue signals that arrive before init completes
  const pendingParents = []; // Queue parents that join before baby has mic ready

  // Module instances
  const wakeLockMgr = new WakeLockManager();
  const alarmMgr = new AlarmManager();
  const esp32Handler = new ESP32AudioHandler(esp32AudioContexts);
  // Sleep tracking is owned by the parent (this tab). One tracker per
  // baby, fed by multiBabyUI.onLevelObserved. Persistence is in
  // localStorage and survives reloads; per-parent observation is the
  // intentional design — different parents may have different rooms /
  // sensitivity and want their own picture.
  const sleepTrackers = new Map();  // babyId → SleepTracker
  let sleepRenderInterval = null;

  // Enable all audio (WebRTC + ESP32) — resumes suspended AudioContexts
  function enableAllAudio() {
    if (webrtcAudioEnabled) return;
    esp32Handler.enableAudio();
    webrtcAudioEnabled = true;

    // Resume any existing AudioContexts
    if (multiStreamManager && multiStreamManager.analysers) {
      multiStreamManager.analysers.forEach(a => {
        if (a.audioContext && a.audioContext.state === 'suspended') a.audioContext.resume();
      });
    }

    // Unmute any existing audio elements
    if (multiStreamManager && multiStreamManager.audioElements) {
      multiStreamManager.audioElements.forEach(audio => {
        audio.muted = false;
        audio.play().catch(() => {});
      });
    }

    const alert = document.getElementById('alert');
    if (alert) alert.hidden = true;
    console.log('Audio enabled');
  }

  window._enableAllAudio = enableAllAudio;

  // Dark mode toggle
  ThemeManager.createToggleButton(document.body);

  // Wake lock setup
  wakeLockMgr.bindEvents(role);

  // ========================
  // Start Monitoring gate (parent only)
  // Browsers require a user gesture before audio can play.
  // This single tap unlocks audio for the entire session.
  // ========================

  function showStartOverlay() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'startOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--color-bg);';
      overlay.innerHTML = `
        <div style="text-align:center;padding:2rem;max-width:360px;">
          <h2 style="font-size:1.4rem;margin-bottom:0.5rem;color:var(--color-text);">BabyLink</h2>
          <p style="color:var(--color-text-muted);margin-bottom:1.5rem;font-size:0.95rem;">Tap to start monitoring</p>
          <button id="startMonitoringBtn" style="
            min-height:56px;width:100%;padding:1em 2em;font-size:1.1rem;font-weight:700;
            border:none;border-radius:var(--radius-md);cursor:pointer;
            background:var(--color-primary);color:white;font-family:var(--font-family);
            box-shadow:var(--shadow-md);transition:all 0.2s;">
            Start Monitoring
          </button>
        </div>`;
      document.body.appendChild(overlay);

      document.getElementById('startMonitoringBtn').addEventListener('click', () => {
        // Create a "pre-warmed" AudioContext during this gesture — it starts running
        window.__sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        enableAllAudio();
        overlay.remove();
        resolve();
      });
    });
  }

  // ========================
  // Initialize based on role
  // ========================

  async function initialize() {
    console.log(`Initializing BabyLink as ${role} (${userName}) in room ${roomId}`);

    // Parent must tap "Start Monitoring" to unlock audio (browser requirement).
    // Dev shortcut: `?autostart=1` skips the gesture — works only when the
    // browser is launched with --autoplay-policy=no-user-gesture-required.
    if (role === 'parent') {
      const skipOverlay = new URLSearchParams(window.location.search).get('autostart') === '1';
      if (skipOverlay) {
        window.__sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        enableAllAudio();
      } else {
        await showStartOverlay();
      }
    }

    if (role === 'baby') {
      await initializeBabyDevice();
    } else if (role === 'parent') {
      await initializeParentDevice();
    }

    isInitialized = true;

    // Process any signals that arrived during initialization
    if (multiStreamManager && pendingSignals.length > 0) {
      console.log(`Processing ${pendingSignals.length} queued signal(s)`);
      pendingSignals.forEach(sig => multiStreamManager.handleSignal(sig));
      pendingSignals.length = 0;
    }

    if (socket.connected && !hasJoinedRoom) {
      joinRoom();
    }

    setTimeout(() => wakeLockMgr.autoRequest(), 1000);
  }

  // Retrieve PIN from sessionStorage (set by select-role page)
  const roomPin = sessionStorage.getItem('babylink-room-pin') || null;

  function joinRoom() {
    if (hasJoinedRoom) return;
    console.log('Joining room:', roomId);
    var joinData = { roomId, role, userName };
    if (roomPin) joinData.pin = roomPin;
    socket.emit('join', joinData);
    hasJoinedRoom = true;
  }

  // ========================
  // Baby device
  // ========================

  async function initializeBabyDevice() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="baby-device-container">
        <h2>Baby Device</h2>
        <div class="baby-name-display">${escapeHtml(userName)}</div>
        <div class="baby-waveform-section">
          <canvas id="waveformCanvas" width="360" height="100"></canvas>
          <div class="baby-mic-status" id="micStatus">Requesting microphone...</div>
        </div>
        <div class="baby-parent-count" id="parentCountSection">
          <div class="parent-count-number" id="parentCountNum">0</div>
          <div class="parent-count-label" id="parentCountLabel">parents monitoring</div>
        </div>
        <div class="baby-actions">
          <button class="baby-test-btn" id="testAudioBtn" disabled>Test Audio</button>
        </div>
        <div class="baby-battery" id="batterySection" style="display:none;">
          <div class="battery-indicator">
            <div class="battery-level" id="batteryLevel"></div>
          </div>
          <span class="battery-text" id="batteryText"></span>
        </div>
      </div>
    `;

    // Set up test audio button
    document.getElementById('testAudioBtn').addEventListener('click', playTestTone);

    // Set up battery indicator
    initBatteryIndicator();

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const configResponse = await fetch('/api/config/webrtc');
      const webrtcConfig = await configResponse.json();
      multiStreamManager = new MultiStreamManager(socket, webrtcConfig);
      multiStreamManager.localStream = localStream;
      document.getElementById('status').textContent = 'Microphone active - streaming to parents';
      document.getElementById('micStatus').textContent = 'Microphone active';
      document.getElementById('micStatus').classList.add('active');
      document.getElementById('testAudioBtn').disabled = false;

      // Start waveform visualization + audio monitoring (crying + sleep tracking)
      startWaveform(localStream);
      startBabyAudioMonitoring(localStream);

      // Connect to any parents that joined while we were waiting for mic permission
      if (pendingParents.length > 0) {
        console.log(`Connecting to ${pendingParents.length} parent(s) that joined during mic setup`);
        pendingParents.forEach(p => createPeerConnectionToParent(p));
        pendingParents.length = 0;
      }
    } catch (err) {
      console.error('Microphone error:', err);
      document.getElementById('status').textContent = 'Microphone access denied';
      document.getElementById('micStatus').textContent = 'Microphone denied';
      document.getElementById('micStatus').classList.add('error');
      document.getElementById('alert').textContent = 'Please allow microphone access to use baby monitor';
      document.getElementById('alert').hidden = false;
    }
  }

  // ========================
  // Baby waveform visualization
  // ========================

  let waveformAnimationId = null;

  function startWaveform(stream) {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Responsive canvas
    function resizeCanvas() {
      canvas.width = canvas.parentElement.clientWidth - 4; // account for border
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function draw() {
      waveformAnimationId = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Draw waveform
      ctx.lineWidth = 2;
      ctx.beginPath();

      const sliceWidth = w / bufferLength;
      let x = 0;

      // Determine color based on volume level
      let maxVal = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = Math.abs(dataArray[i] - 128) / 128;
        if (v > maxVal) maxVal = v;
      }

      if (maxVal > 0.5) {
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim();
      } else if (maxVal > 0.15) {
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-warning').trim();
      } else {
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-success').trim();
      }

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }

      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }

    draw();
  }

  // ========================
  // Baby-side audio monitoring
  // - Crying detection → notifies server for ntfy push
  // - Sleep tracking → logs state transitions to localStorage
  // ========================

  function startBabyAudioMonitoring(stream) {
    var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var source = audioCtx.createMediaStreamSource(stream);
    var analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    var bufferLength = analyser.frequencyBinCount;
    var dataArray = new Uint8Array(bufferLength);

    // --- Crying detection state ---
    var isCrying = false;
    var lastCryingEmit = 0;
    var CRYING_COOLDOWN = 10000;
    var RED_THRESHOLD = 180;
    var YELLOW_THRESHOLD = 100;

    function getLevel(volume) {
      if (volume > RED_THRESHOLD) return 'RED';
      if (volume > YELLOW_THRESHOLD) return 'YELLOW';
      return 'GREEN';
    }

    function check() {
      // Use frequency data (same as multi-stream-manager on parent side)
      analyser.getByteFrequencyData(dataArray);

      // Peak frequency bin value (matches parent-side detection)
      var peak = 0;
      for (var i = 0; i < bufferLength; i++) {
        if (dataArray[i] > peak) peak = dataArray[i];
      }
      var volume = peak;
      var level = getLevel(volume);

      // --- Crying detection ---
      if (level === 'RED') {
        var now = Date.now();
        if (!isCrying || now - lastCryingEmit > CRYING_COOLDOWN) {
          isCrying = true;
          lastCryingEmit = now;
          socket.emit('crying-detected', { roomId: roomId, babyId: socket.id, babyName: userName });
        }
      } else {
        isCrying = false;
      }
    }

    setInterval(check, 500);
  }

  // ========================
  // Test audio tone
  // ========================

  function playTestTone() {
    const btn = document.getElementById('testAudioBtn');
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    btn.textContent = 'Playing...';

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(440, audioCtx.currentTime); // A4 note
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.5);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 1.5);

    oscillator.onended = function() {
      audioCtx.close();
      btn.disabled = false;
      btn.textContent = 'Test Audio';
    };
  }

  // ========================
  // Battery indicator
  // ========================

  function updateParentCount(participants) {
    const count = participants.filter(function(p) { return p.role === 'parent'; }).length;
    var numEl = document.getElementById('parentCountNum');
    var labelEl = document.getElementById('parentCountLabel');
    if (numEl) numEl.textContent = count;
    if (labelEl) labelEl.textContent = count === 1 ? 'parent monitoring' : 'parents monitoring';
  }

  function initBatteryIndicator() {
    if (!navigator.getBattery) return;

    navigator.getBattery().then(function(battery) {
      var section = document.getElementById('batterySection');
      if (!section) return;
      section.style.display = 'flex';

      function updateBattery() {
        var pct = Math.round(battery.level * 100);
        var levelEl = document.getElementById('batteryLevel');
        var textEl = document.getElementById('batteryText');
        if (!levelEl || !textEl) return;

        levelEl.style.width = pct + '%';
        textEl.textContent = pct + '%' + (battery.charging ? ' (charging)' : '');

        levelEl.className = 'battery-level';
        if (pct <= 15) levelEl.classList.add('low');
        else if (pct <= 30) levelEl.classList.add('medium');
      }

      updateBattery();
      battery.addEventListener('levelchange', updateBattery);
      battery.addEventListener('chargingchange', updateBattery);
    }).catch(function() { /* Battery API not available */ });
  }

  // ========================
  // Parent device
  // ========================

  async function initializeParentDevice() {
    const container = document.getElementById('mainContainer');
    multiBabyUI = new MultiBabyUI(container);

    const configResponse = await fetch('/api/config/webrtc');
    const webrtcConfig = await configResponse.json();
    multiStreamManager = new MultiStreamManager(socket, webrtcConfig);
    // Make the parent-side stream manager addressable for cross-file
    // coordination (ESP32AudioHandler peeks at audioStreams to decide
    // whether to mute the WSS-PCM playback for a baby that's already
    // playing via WebRTC).
    window._multiStreamManager = multiStreamManager;

    // Wire up UI callbacks to stream manager + ESP32
    multiBabyUI.onMuteToggle = (babyId, mute) => {
      multiStreamManager.muteParticipant(babyId, mute);
      if (esp32AudioContexts.has(babyId)) {
        const ctx = esp32AudioContexts.get(babyId);
        ctx.gainNode.gain.value = mute ? 0 : (ctx.volume || 1.0);
      }
    };

    multiBabyUI.onVolumeChange = (babyId, volume) => {
      multiStreamManager.setParticipantVolume(babyId, volume);
      if (esp32AudioContexts.has(babyId)) {
        const ctx = esp32AudioContexts.get(babyId);
        ctx.volume = volume;
        ctx.gainNode.gain.value = volume;
      }
    };

    multiBabyUI.onSensitivityChange = (babyId, sensitivity) => {
      multiStreamManager.setSensitivity(babyId, sensitivity);
      if (esp32AudioContexts.has(babyId)) {
        const ctx = esp32AudioContexts.get(babyId);
        ctx.sensitivity = sensitivity;
        ctx.sensitivityGain = sensitivity;
      }
      // Live-tune the sleep tracker's volume thresholds. Past slots
      // stay as recorded (re-classification would need the raw
      // volume samples we don't keep); new observations use the
      // updated thresholds immediately.
      const tracker = sleepTrackers.get(babyId);
      if (tracker) tracker.setSensitivity(sensitivity);
    };

    multiBabyUI.onSoloToggle = (babyId) => {
      for (const [id] of multiBabyUI.babyCards) {
        multiStreamManager.muteParticipant(id, id !== babyId);
      }
    };

    multiStreamManager.onStreamAdded = (participantId, stream, participantInfo) => {
      multiBabyUI.addBaby(participantId, participantInfo);
      enableAllAudio();
    };

    multiStreamManager.onStreamRemoved = (participantId) => {
      multiBabyUI.removeBaby(participantId);
    };

    // Cross-source volume tap: every level update funnels through
    // multi-baby-ui (both WSS-PCM via esp32-audio-handler and WebRTC
    // via multi-stream-manager land here). Lazy-create the per-baby
    // SleepTracker on first observation so babies whose WebRTC
    // handshake fails (esp_peer SDP retry exhausted, etc.) still get
    // tracked from the WSS-PCM analyser feed.
    multiBabyUI.onLevelObserved = (babyId, level, volume) => {
      let tracker = sleepTrackers.get(babyId);
      if (!tracker) {
        const sens = multiBabyUI.sensitivity.get(babyId) || 1.0;
        tracker = new SleepTracker(babyId, roomId, { sensitivity: sens });
        sleepTrackers.set(babyId, tracker);
      }
      tracker.observe(volume);
    };

    // Re-render every baby's sleep timeline on a 5 s tick. The
    // tracker's internal state moves at 1 Hz so 5 s is the right
    // balance between detail-bar movement and DOM churn.
    sleepRenderInterval = setInterval(() => {
      for (const [babyId, tracker] of sleepTrackers) {
        multiBabyUI.renderSleepTimeline(babyId, tracker);
      }
    }, 5000);

    // Track crying state per baby to avoid spamming socket events
    const cryingState = new Map(); // babyId → { isCrying, lastEmit }
    const CRYING_EMIT_COOLDOWN = 10000; // Emit every 10s while baby is crying

    multiStreamManager.onAudioLevelUpdate = (participantId, level, volume) => {
      multiBabyUI.updateAudioLevel(participantId, level, volume);

      // Notify server when crying detected (RED level)
      if (level === 'RED') {
        const state = cryingState.get(participantId) || { isCrying: false, lastEmit: 0 };
        const now = Date.now();
        if (!state.isCrying || now - state.lastEmit > CRYING_EMIT_COOLDOWN) {
          state.isCrying = true;
          state.lastEmit = now;
          cryingState.set(participantId, state);

          var babyCard = multiBabyUI.babyCards.get(participantId);
          var babyName = (babyCard && babyCard.participantInfo && babyCard.participantInfo.userName) || 'Baby';
          socket.emit('crying-detected', { roomId, babyId: participantId, babyName: babyName });
        }
      } else {
        var s = cryingState.get(participantId);
        if (s) s.isCrying = false;
      }
    };

    document.getElementById('status').textContent = '\uD83D\uDC42 Listening for babies...';
  }

  // ========================
  // Peer connection (baby → parent)
  // ========================

  async function createPeerConnectionToParent(parent) {
    try {
      if (multiStreamManager.peerConnections.has(parent.socketId)) return;

      const peer = multiStreamManager.createPeerConnection(parent.socketId, parent);

      if (localStream) {
        localStream.getTracks().forEach(track => {
          peer.addTrack(track, localStream);
        });
      }

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit('signal', { offer, to: parent.socketId });
    } catch (error) {
      console.error('Error creating peer connection to parent:', error);
    }
  }

  // ========================
  // Socket event handlers
  // ========================

  socket.on('connect', () => {
    console.log('Connected to server');
    document.getElementById('status').textContent = 'Connected - Rejoining room...';
    document.getElementById('alert').hidden = true;
    alarmMgr.stop();

    if (wasDisconnected) {
      hasJoinedRoom = false;
      if (role === 'parent' && multiBabyUI) {
        const babyIds = Array.from(multiBabyUI.babyCards.keys());
        babyIds.forEach(id => {
          multiBabyUI.removeBaby(id);
          multiStreamManager.removeParticipant(id);
        });
      }
      wasDisconnected = false;
    }

    if (isInitialized) joinRoom();
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected from server:', reason);
    document.getElementById('status').textContent = 'Disconnected - Reconnecting...';
    wasDisconnected = true;

    setTimeout(() => {
      if (!socket.connected) {
        document.getElementById('alert').textContent = 'Connection lost. Attempting to reconnect...';
        document.getElementById('alert').hidden = false;
      }
    }, 3000);

    if (role === 'parent') {
      alarmMgr.schedule(5000, () => !socket.connected);
      if (multiBabyUI) {
        for (const [babyId] of multiBabyUI.babyCards) {
          multiBabyUI.updateBabyStatus(babyId, false, 'Server disconnected');
        }
      }
    }
  });

  socket.on('room-state', (data) => {
    const { participants } = data;

    if (role === 'baby') {
      updateParentCount(participants);

      participants.filter(p => p.role === 'parent').forEach(async (parent) => {
        if (multiStreamManager && localStream) {
          await createPeerConnectionToParent(parent);
        } else {
          pendingParents.push(parent);
        }
      });
    } else if (role === 'parent') {
      const babies = participants.filter(p => p.role === 'baby');
      babies.forEach(baby => {
        if (!multiBabyUI.babyCards.has(baby.socketId)) {
          multiBabyUI.addBaby(baby.socketId, baby);
        }
        // All baby types (PWA, classic ESP32, XIAO S3) take the same
        // dispatch now: ask the baby to send us an offer. The signal
        // handler routes the inbound offer to multiStreamManager which
        // creates the peer + audio element. S3 babies generate their
        // own offer from esp_peer; PWA babies create one from
        // RTCPeerConnection.createOffer(); classic ESP32 stays on the
        // legacy WSS-PCM path because it doesn't speak WebRTC and the
        // requestOffer goes nowhere.
        if (!multiStreamManager.peerConnections.has(baby.socketId)) {
          socket.emit('signal', { requestOffer: true, to: baby.socketId });
        }
      });
      if (babies.length > 0) alarmMgr.stop();
    }
  });

  socket.on('participant-joined', (data) => {
    const { role: pRole, socketId, userName: pName, participants } = data;

    if (role === 'baby' && pRole === 'parent') {
      updateParentCount(participants);

      const parentInfo = { socketId, role: pRole, userName: pName };
      if (multiStreamManager && localStream) {
        createPeerConnectionToParent(parentInfo);
      } else {
        // Mic not ready yet — queue and process after init
        pendingParents.push(parentInfo);
      }
    } else if (role === 'parent' && pRole === 'baby') {
      multiBabyUI.addBaby(socketId, { socketId, role: pRole, userName: pName });
      if (multiBabyUI.babyCards.size > 0) alarmMgr.stop();
      // Unified dispatch — same requestOffer kickoff for every baby
      // type. multiStreamManager handles the inbound offer regardless
      // of source. See the room-state handler above for the rationale.
      socket.emit('signal', { requestOffer: true, to: socketId });
    }
  });

  socket.on('participant-left', (data) => {
    const { role: pRole, socketId, participants } = data;

    if (role === 'baby' && pRole === 'parent') {
      updateParentCount(participants);
    } else if (role === 'parent' && pRole === 'baby') {
      multiBabyUI.removeBaby(socketId);
      multiStreamManager.removeParticipant(socketId);
      const tracker = sleepTrackers.get(socketId);
      if (tracker) { tracker.destroy(); sleepTrackers.delete(socketId); }
      if (multiBabyUI.babyCards.size === 0) alarmMgr.play();
    }
  });

  socket.on('signal', (data) => {
    // Handle request from parent asking baby to (re)send an offer
    if (data.requestOffer && role === 'baby' && multiStreamManager && localStream) {
      console.log('Parent requested offer, creating peer connection to', data.fromSocketId);
      createPeerConnectionToParent({ socketId: data.fromSocketId, role: 'parent', userName: data.fromUserName || 'Parent' });
      return;
    }

    if (multiStreamManager) {
      multiStreamManager.handleSignal(data);
    } else {
      pendingSignals.push(data);
    }
  });

  socket.on('error', (data) => {
    console.error('Server error:', data);
    document.getElementById('alert').textContent = `Error: ${data.message}`;
    document.getElementById('alert').hidden = false;
  });

  socket.on('esp32-audio', (data) => {
    if (role !== 'parent') return;
    esp32Handler.handleAudioData(data, multiBabyUI);
  });

  // ========================
  // Start
  // ========================

  initialize().catch(err => {
    console.error('FATAL: initialize() failed:', err);
    document.getElementById('status').textContent = 'Error: ' + err.message;
  });

})();
