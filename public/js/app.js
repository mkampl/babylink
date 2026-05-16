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
  const notificationUI = new NotificationUI(roomId);

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

  // Expose toggle for notification settings onclick
  window.toggleNotificationSettings = function() {
    notificationUI.toggle();
  };

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

    // Parent must tap "Start Monitoring" to unlock audio (browser requirement)
    if (role === 'parent') {
      await showStartOverlay();
    }

    if (role === 'baby') {
      await initializeBabyDevice();
    } else if (role === 'parent') {
      await initializeParentDevice();
      notificationUI.initialize();
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

  function joinRoom() {
    if (hasJoinedRoom) return;
    console.log('Joining room:', roomId);
    socket.emit('join', { roomId, role, userName });
    hasJoinedRoom = true;
  }

  // ========================
  // Baby device
  // ========================

  async function initializeBabyDevice() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="baby-device-container">
        <h2>\uD83C\uDFA4 Baby Device</h2>
        <div class="baby-name-display">\uD83D\uDC76 ${escapeHtml(userName)}</div>
        <div class="connection-status" id="babyConnectionStatus">
          <span>\uD83D\uDFE2 Connected</span>
          <span id="parentCount">Waiting for parents...</span>
        </div>
        <p style="color: var(--color-text-secondary);">This device is streaming audio to parent devices.</p>
      </div>
    `;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const configResponse = await fetch('/api/config/webrtc');
      const webrtcConfig = await configResponse.json();
      multiStreamManager = new MultiStreamManager(socket, webrtcConfig);
      multiStreamManager.localStream = localStream;
      document.getElementById('status').textContent = '\uD83C\uDFA4 Microphone active - streaming to parents';

      // Connect to any parents that joined while we were waiting for mic permission
      if (pendingParents.length > 0) {
        console.log(`Connecting to ${pendingParents.length} parent(s) that joined during mic setup`);
        pendingParents.forEach(p => createPeerConnectionToParent(p));
        pendingParents.length = 0;
      }
    } catch (err) {
      console.error('Microphone error:', err);
      document.getElementById('status').textContent = 'Microphone access denied';
      document.getElementById('alert').textContent = 'Please allow microphone access to use baby monitor';
      document.getElementById('alert').hidden = false;
    }
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

    multiStreamManager.onAudioLevelUpdate = (participantId, level, volume) => {
      multiBabyUI.updateAudioLevel(participantId, level, volume);
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
      const parentCount = participants.filter(p => p.role === 'parent').length;
      const el = document.getElementById('parentCount');
      if (el) el.textContent = `${parentCount} parent${parentCount !== 1 ? 's' : ''} monitoring`;

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
        // Request baby to send offer if no peer connection exists yet
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
      const parentCount = participants.filter(p => p.role === 'parent').length;
      const el = document.getElementById('parentCount');
      if (el) el.textContent = `${parentCount} parent${parentCount !== 1 ? 's' : ''} monitoring`;

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
      // Request the new baby to send us an offer
      socket.emit('signal', { requestOffer: true, to: socketId });
    }
  });

  socket.on('participant-left', (data) => {
    const { role: pRole, socketId, participants } = data;

    if (role === 'baby' && pRole === 'parent') {
      const parentCount = participants.filter(p => p.role === 'parent').length;
      const el = document.getElementById('parentCount');
      if (el) el.textContent = `${parentCount} parent${parentCount !== 1 ? 's' : ''} monitoring`;
    } else if (role === 'parent' && pRole === 'baby') {
      multiBabyUI.removeBaby(socketId);
      multiStreamManager.removeParticipant(socketId);
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
