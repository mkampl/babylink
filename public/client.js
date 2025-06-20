// public/client.js - Updated for BabyLink
const socket = io();
const params = new URLSearchParams(window.location.search);
const role = params.get("role") || "parent";
const roomId = window.location.pathname.slice(1);

// DOM elements
const remoteAudio = document.getElementById("remoteAudio");
const status = document.getElementById("status");
const mic = document.getElementById("mic");
const speaker = document.getElementById("speaker");
const alert = document.getElementById("alert");
const playAudioBtn = document.getElementById("playAudio");
const controls = document.getElementById("controls");

// WebRTC configuration
let peer = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});

let localStream = null;
let remoteRoleConnected = false;
let userHasInteracted = false;
let audioPermissionGranted = false;

// Connection monitoring
let connectionHealthy = true;
let babyConnected = false;
let serverConnected = true;
let connectionCheckInterval = null;
let alarmAudio = null;
let alarmInterval = null;

// Voice Activity Detection for Parent
let audioContext = null;
let analyser = null;
let dataArray = null;
let source = null;
let isMonitoring = false;

// Audio Level Thresholds (0-255)
const LEVELS = {
  GREEN: { min: 0, max: 30, name: "Quiet", color: "#4CAF50" },
  YELLOW: { min: 31, max: 80, name: "Movement", color: "#FFC107" },
  RED: { min: 81, max: 255, name: "Crying", color: "#F44336" }
};

// Timing states
let currentLevel = 'GREEN';
let levelStartTime = Date.now();
let isMuted = true;
let isManuallyMuted = false;
let isManuallyListening = false;
let yellowTimer = null;
let redTimer = null;

// Visual elements
let levelIndicator = null;
let volumeMeter = null;

// Wake Lock integration
function integrateBabyLinkWakeLock() {
  // Auto-request wake lock when monitoring becomes active
  if (typeof autoRequestWakeLock === 'function') {
    console.log('🔒 BabyLink: Requesting wake lock for baby monitoring');
    autoRequestWakeLock();
  }
}

// Activity logging
function logActivity(message, type = 'info') {
  const logElement = document.getElementById('activityLog');
  if (!logElement) return;
  
  const timestamp = new Date().toLocaleTimeString();
  const colors = {
    info: '#666',
    mute: '#ff5722',
    unmute: '#4caf50',
    manual: '#2196f3',
    auto: '#9c27b0'
  };
  
  const logEntry = document.createElement('div');
  logEntry.style.cssText = `
    margin: 0.2em 0;
    color: ${colors[type] || colors.info};
    border-bottom: 1px solid #eee;
    padding-bottom: 0.2em;
  `;
  logEntry.innerHTML = `<span style="color: #888;">[${timestamp}]</span> ${message}`;
  
  logElement.appendChild(logEntry);
  logElement.scrollTop = logElement.scrollHeight;
  
  // Keep only last 20 entries
  while (logElement.children.length > 20) {
    logElement.removeChild(logElement.firstChild);
  }
}

// Manual control functions
function setupManualControls() {
  const listenBtn = document.getElementById('manualListenBtn');
  const muteBtn = document.getElementById('manualMuteBtn');
  
  listenBtn.addEventListener('click', () => {
    isManuallyListening = true;
    isManuallyMuted = false;
    unmuteAudio('manual');
    updateManualButtons();
    logActivity('🔊 Manual listen activated', 'manual');
    
    // Auto-disable manual listen after 30 seconds unless baby is crying
    setTimeout(() => {
      if (isManuallyListening && currentLevel !== 'RED') {
        isManuallyListening = false;
        updateManualButtons();
        // Resume automatic behavior
        if (currentLevel === 'GREEN') {
          muteAudio('auto');
        }
        logActivity('⏱️ Manual listen timeout (30s)', 'auto');
      }
    }, 30000);
  });
  
  muteBtn.addEventListener('click', () => {
    isManuallyMuted = true;
    isManuallyListening = false;
    muteAudio('manual');
    updateManualButtons();
    logActivity('🔇 Manual mute activated', 'manual');
    
    // Auto-disable manual mute if baby starts crying
    // This is handled in handleLevelChange for RED level
  });
  
  updateManualButtons();
}

function updateManualButtons() {
  const listenBtn = document.getElementById('manualListenBtn');
  const muteBtn = document.getElementById('manualMuteBtn');
  
  if (!listenBtn || !muteBtn) return;
  
  if (isManuallyListening) {
    listenBtn.style.background = '#4caf50';
    listenBtn.textContent = '✅ Listening';
    listenBtn.disabled = true;
  } else {
    listenBtn.style.background = '#2196f3';
    listenBtn.textContent = '🔊 Listen Now';
    listenBtn.disabled = false;
  }
  
  if (isManuallyMuted) {
    muteBtn.style.background = '#f44336';
    muteBtn.textContent = '🔇 Muted';
    muteBtn.disabled = false;
  } else {
    muteBtn.style.background = '#ff5722';
    muteBtn.textContent = '🔇 Mute';
    muteBtn.disabled = false;
  }
  
  // Allow unmuting even when manually muted
  if (isManuallyMuted) {
    muteBtn.onclick = () => {
      isManuallyMuted = false;
      isManuallyListening = false;
      updateManualButtons();
      // Resume automatic behavior
      if (currentLevel === 'GREEN') {
        muteAudio('auto');
      } else {
        unmuteAudio('auto');
      }
      logActivity('🔊 Manual mute deactivated', 'manual');
    };
  } else {
    muteBtn.onclick = () => {
      isManuallyMuted = true;
      isManuallyListening = false;
      muteAudio('manual');
      updateManualButtons();
      logActivity('🔇 Manual mute activated', 'manual');
    };
  }
}

// Initialize alarm sound
function initializeAlarm() {
  // Create alarm sound using Web Audio API
  if (!alarmAudio && audioContext) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    alarmAudio = { oscillator, gainNode };
  }
}

function playAlarm() {
  if (role !== "parent") return;
  
  console.log("🚨 Playing connection alarm");
  logActivity('🚨 CONNECTION ALARM - Baby device disconnected', 'mute');
  
  // Visual alarm - red background
  document.body.style.background = "#ff4444";
  document.body.style.transition = "background-color 0.3s";
  
  // Audio alarm - beeping sound
  if (!alarmInterval) {
    alarmInterval = setInterval(() => {
      if (audioContext && audioContext.state === 'running') {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1000, audioContext.currentTime);
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime + 0.1);
        
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.2, audioContext.currentTime + 0.1);
        gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.3);
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);
      }
    }, 1000); // Beep every second
  }
}

function stopAlarm() {
  if (role !== "parent") return;
  
  console.log("✅ Stopping connection alarm");
  logActivity('✅ Connection restored', 'unmute');
  
  // Reset background
  document.body.style.background = "#f3f4f6";
  
  // Stop audio alarm
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
}

function checkConnectionHealth() {
  const wasHealthy = connectionHealthy;
  connectionHealthy = serverConnected && babyConnected && (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed');
  
  if (role === "parent") {
    if (!connectionHealthy && wasHealthy) {
      console.log("⚠️ Connection became unhealthy");
      playAlarm();
      
      let reason = "";
      if (!serverConnected) reason = "Server disconnected";
      else if (!babyConnected) reason = "Baby device disconnected";
      else reason = "WebRTC connection lost";
      
      status.textContent = `🚨 CONNECTION LOST: ${reason}`;
      alert.textContent = `⚠️ ALARM: Cannot monitor baby - ${reason}`;
      alert.hidden = false;
      alert.style.background = "#ff4444";
      alert.style.color = "white";
      
    } else if (connectionHealthy && !wasHealthy) {
      console.log("✅ Connection restored");
      stopAlarm();
      
      status.textContent = "🔗 Connection restored - Monitoring active";
      alert.textContent = "✅ Connection restored";
      alert.style.background = "#4CAF50";
      alert.style.color = "white";
      
      setTimeout(() => {
        alert.hidden = true;
        alert.style.background = "";
        alert.style.color = "";
      }, 3000);
    }
  }
}

// Peer connection event handlers
peer.oniceconnectionstatechange = () => {
  console.log("🌐 ICE Connection State:", peer.iceConnectionState);
  
  if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
    console.log("✅ WebRTC connection established");
    // Request wake lock when connection is established
    integrateBabyLinkWakeLock();
  } else if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
    console.log("❌ WebRTC connection lost");
  }
  
  checkConnectionHealth();
};

peer.onicecandidate = (event) => {
  if (event.candidate) {
    socket.emit("signal", { candidate: event.candidate });
    console.log("📤 ICE candidate sent");
  }
};

// Handle incoming signals
socket.on("signal", async (data) => {
  console.log("📥 Signal received from", data.from || "unknown", ":", Object.keys(data));
  
  try {
    if (data.offer) {
      console.log("📥 Processing offer");
      await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("signal", { answer });
      console.log("📤 Answer sent");
    } 
    else if (data.answer) {
      console.log("📥 Processing answer");
      await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
    } 
    else if (data.candidate) {
      await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log("📥 ICE candidate added");
    }
  } catch (error) {
    console.error("❌ Error processing signal:", error);
  }
});

// Room state management
socket.on("participant-joined", ({ role: joinedRole, participants }) => {
  console.log(`👤 ${joinedRole} joined BabyLink room`);
  updateConnectionStatus(participants);
  
  // Reset connection when someone rejoins after disconnect
  if ((role === "baby" && joinedRole === "parent") || (role === "parent" && joinedRole === "baby")) {
    console.log("🔄 Participant rejoined, resetting connection");
    resetPeerConnection();
  }
  
  if (role === "baby" && joinedRole === "parent" && localStream) {
    console.log("🎙️ Parent joined, baby initiating connection");
    setTimeout(() => initiateConnection(), 1000); // Add delay for reset
  }
});

socket.on("participant-left", ({ role: leftRole, participants }) => {
  console.log(`👤 ${leftRole} left BabyLink room`);
  updateConnectionStatus(participants);
  
  // Reset peer connection when the other party leaves
  if ((role === "baby" && leftRole === "parent") || (role === "parent" && leftRole === "baby")) {
    console.log("🔄 Other participant left, preparing for reconnection");
    resetPeerConnection();
  }
});

socket.on("room-state", ({ participants }) => {
  console.log("🏠 BabyLink room state:", participants.map(p => p.role));
  updateConnectionStatus(participants);
  
  if (role === "baby" && participants.some(p => p.role === "parent") && localStream) {
    console.log("🎙️ Parent already present, baby initiating connection");
    setTimeout(initiateConnection, 1000);
  }
});

function updateConnectionStatus(participants) {
  const hasParent = participants.some(p => p.role === "parent");
  const hasBaby = participants.some(p => p.role === "baby");
  
  babyConnected = role === "parent" ? hasBaby : hasParent;
  remoteRoleConnected = babyConnected;
  
  if (hasParent && hasBaby) {
    status.textContent = "🔗 Both devices connected";
  } else if (role === "baby") {
    status.textContent = hasParent ? "🔗 Parent found, connecting..." : "⏳ Waiting for parent...";
  } else {
    status.textContent = hasBaby ? "🔗 Baby found, connecting..." : "⏳ Waiting for baby...";
  }
  
  checkConnectionHealth();
}

async function initiateConnection() {
  try {
    console.log("🚀 Initiating WebRTC connection");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("signal", { offer });
    console.log("📤 Offer sent");
  } catch (error) {
    console.error("❌ Error creating offer:", error);
  }
}

// Voice Activity Detection Functions
function createVisualElements() {
  // Level Indicator
  levelIndicator = document.createElement('div');
  levelIndicator.id = 'levelIndicator';
  levelIndicator.style.cssText = `
    background: ${LEVELS.GREEN.color};
    color: white;
    padding: 1em;
    margin: 1em 0;
    border-radius: 10px;
    font-weight: bold;
    font-size: 1.2em;
    text-align: center;
    transition: all 0.3s ease;
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
  `;
  levelIndicator.textContent = `🟢 ${LEVELS.GREEN.name} - Audio muted`;
  
  // Manual Listen Controls
  const manualControls = document.createElement('div');
  manualControls.style.cssText = `
    display: flex;
    gap: 10px;
    margin: 1em 0;
    justify-content: center;
  `;
  
  const listenBtn = document.createElement('button');
  listenBtn.id = 'manualListenBtn';
  listenBtn.textContent = '🔊 Listen Now';
  listenBtn.style.cssText = `
    background: #2196f3;
    color: white;
    border: none;
    padding: 0.8em 1.5em;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1em;
    transition: background-color 0.3s;
  `;
  
  const muteBtn = document.createElement('button');
  muteBtn.id = 'manualMuteBtn';
  muteBtn.textContent = '🔇 Mute';
  muteBtn.style.cssText = `
    background: #ff5722;
    color: white;
    border: none;
    padding: 0.8em 1.5em;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1em;
    transition: background-color 0.3s;
  `;
  
  manualControls.appendChild(listenBtn);
  manualControls.appendChild(muteBtn);
  
  // Volume Meter
  volumeMeter = document.createElement('div');
  volumeMeter.id = 'volumeMeter';
  volumeMeter.style.cssText = `
    background: #f0f0f0;
    height: 20px;
    border-radius: 10px;
    margin: 1em 0;
    overflow: hidden;
    border: 2px solid #ddd;
  `;
  
  const volumeBar = document.createElement('div');
  volumeBar.id = 'volumeBar';
  volumeBar.style.cssText = `
    height: 100%;
    width: 0%;
    background: ${LEVELS.GREEN.color};
    transition: all 0.1s ease;
    border-radius: 8px;
  `;
  volumeMeter.appendChild(volumeBar);
  
  // Info Panel
  const infoPanel = document.createElement('div');
  infoPanel.style.cssText = `
    background: #fff;
    padding: 1em;
    margin: 1em 0;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    font-size: 0.9em;
    text-align: left;
  `;
  infoPanel.innerHTML = `
    <strong>🎵 BabyLink Voice Monitoring:</strong><br>
    🟢 <strong>Quiet:</strong> Audio muted<br>
    🟡 <strong>Movement:</strong> Activation after 5 sec<br>
    🔴 <strong>Crying:</strong> Immediate activation<br>
    <em>Manual controls override automatic behavior temporarily</em>
  `;
  
  // Activity Log
  const logContainer = document.createElement('div');
  logContainer.style.cssText = `
    background: #f9f9f9;
    border: 1px solid #ddd;
    border-radius: 8px;
    margin: 1em 0;
    max-height: 200px;
    overflow-y: auto;
  `;
  
  const logHeader = document.createElement('div');
  logHeader.style.cssText = `
    background: #e0e0e0;
    padding: 0.5em 1em;
    font-weight: bold;
    border-bottom: 1px solid #ddd;
  `;
  logHeader.textContent = '📋 BabyLink Activity Log';
  
  const logContent = document.createElement('div');
  logContent.id = 'activityLog';
  logContent.style.cssText = `
    padding: 1em;
    font-family: monospace;
    font-size: 0.85em;
    max-height: 150px;
    overflow-y: auto;
  `;
  logContent.innerHTML = '<div style="color: #666;">Waiting for audio activity...</div>';
  
  logContainer.appendChild(logHeader);
  logContainer.appendChild(logContent);
  
  controls.appendChild(levelIndicator);
  controls.appendChild(manualControls);
  controls.appendChild(volumeMeter);
  controls.appendChild(infoPanel);
  controls.appendChild(logContainer);
  
  // Add manual control event listeners
  setupManualControls();
}

function initializeAudioAnalysis(stream) {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    source = audioContext.createMediaStreamSource(stream);
    
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    source.connect(analyser);
    
    console.log("🎵 BabyLink audio analysis initialized");
    logActivity('🎵 BabyLink monitoring system initialized', 'info');
    initializeAlarm();
    startMonitoring();
    
  } catch (error) {
    console.error("❌ Audio analysis setup failed:", error);
    logActivity('❌ Audio analysis setup failed', 'info');
  }
}

function startMonitoring() {
  if (!isMonitoring) {
    isMonitoring = true;
    monitorAudioLevel();
    console.log("👂 BabyLink audio monitoring started");
    logActivity('👂 Voice activity detection started', 'info');
    
    // Request wake lock when monitoring starts
    integrateBabyLinkWakeLock();
    
    // Start connection health monitoring
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
    connectionCheckInterval = setInterval(checkConnectionHealth, 2000);
  }
}

function monitorAudioLevel() {
  if (!isMonitoring || !analyser) return;
  
  analyser.getByteFrequencyData(dataArray);
  
  // Calculate average volume
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }
  const average = sum / dataArray.length;
  
  // Determine current level
  let newLevel = 'GREEN';
  if (average >= LEVELS.RED.min) {
    newLevel = 'RED';
  } else if (average >= LEVELS.YELLOW.min) {
    newLevel = 'YELLOW';
  }
  
  // Update visual meter
  updateVolumeMeter(average, newLevel);
  
  // Handle level changes
  if (newLevel !== currentLevel) {
    handleLevelChange(newLevel);
  }
  
  // Continue monitoring
  requestAnimationFrame(monitorAudioLevel);
}

function updateVolumeMeter(volume, level) {
  const volumeBar = document.getElementById('volumeBar');
  const percentage = Math.min((volume / 255) * 100, 100);
  
  if (volumeBar) {
    volumeBar.style.width = `${percentage}%`;
    volumeBar.style.background = LEVELS[level].color;
  }
}

function handleLevelChange(newLevel) {
  console.log(`🔊 Level changed: ${currentLevel} → ${newLevel}`);
  
  const previousLevel = currentLevel;
  currentLevel = newLevel;
  levelStartTime = Date.now();
  
  // Clear existing timers
  if (yellowTimer) clearTimeout(yellowTimer);
  if (redTimer) clearTimeout(redTimer);
  
  // Update visual indicator
  updateLevelIndicator(newLevel);
  
  // Log level change
  const levelEmoji = newLevel === 'GREEN' ? '🟢' : newLevel === 'YELLOW' ? '🟡' : '🔴';
  logActivity(`${levelEmoji} Audio level: ${LEVELS[newLevel].name}`, 'info');
  
  // Handle audio muting/unmuting based on manual state and level
  switch (newLevel) {
    case 'GREEN':
      // Mute after delay if coming from yellow/red and not manually listening
      if (!isMuted && !isManuallyListening) {
        const delay = previousLevel === 'RED' ? 10000 : 5000; // 10s for red, 5s for yellow
        setTimeout(() => {
          if (currentLevel === 'GREEN' && !isManuallyListening) {
            muteAudio('auto');
          }
        }, delay);
      }
      break;
      
    case 'YELLOW':
      // Unmute after 5 seconds if not manually muted
      if (!isManuallyMuted) {
        yellowTimer = setTimeout(() => {
          if (currentLevel === 'YELLOW' && !isManuallyMuted) {
            unmuteAudio('auto');
          }
        }, 5000);
      }
      break;
      
    case 'RED':
      // Immediate unmute - overrides manual mute for crying baby
      if (isManuallyMuted) {
        isManuallyMuted = false;
        updateManualButtons();
        logActivity('🚨 CRYING DETECTED - Manual mute overridden!', 'unmute');
      }
      unmuteAudio('auto');
      break;
  }
}

function updateLevelIndicator(level) {
  if (!levelIndicator) return;
  
  const levelInfo = LEVELS[level];
  const emoji = level === 'GREEN' ? '🟢' : level === 'YELLOW' ? '🟡' : '🔴';
  
  let muteStatus = '';
  if (isManuallyMuted) {
    muteStatus = 'Manually muted';
  } else if (isManuallyListening) {
    muteStatus = 'Manually listening';
  } else {
    muteStatus = isMuted ? 'Auto muted' : 'Auto active';
  }
  
  levelIndicator.style.background = levelInfo.color;
  levelIndicator.textContent = `${emoji} ${levelInfo.name} - ${muteStatus}`;
}

function muteAudio(source = 'auto') {
  if (remoteAudio && !isMuted) {
    remoteAudio.muted = true;
    isMuted = true;
    console.log(`🔇 Audio muted (${source})`);
    updateLevelIndicator(currentLevel);
    
    const sourceText = source === 'manual' ? 'Manual' : 'Automatic';
    logActivity(`🔇 ${sourceText} mute activated`, 'mute');
  }
}

function unmuteAudio(source = 'auto') {
  if (remoteAudio && isMuted) {
    remoteAudio.muted = false;
    isMuted = false;
    console.log(`🔊 Audio unmuted (${source})`);
    updateLevelIndicator(currentLevel);
    
    const sourceText = source === 'manual' ? 'Manual' : 'Automatic';
    const reason = currentLevel === 'RED' ? ' (CRYING)' : currentLevel === 'YELLOW' ? ' (Movement)' : '';
    logActivity(`🔊 ${sourceText} unmute activated${reason}`, 'unmute');
  }
}

// Audio handling functions
async function attemptAutoplay() {
  if (!audioPermissionGranted) {
    console.log("⚠️ No audio permission, showing manual button");
    showManualPlayOption();
    return;
  }

  try {
    // Start muted for voice activation
    remoteAudio.muted = true;
    isMuted = true;
    await remoteAudio.play();
    console.log("✅ Audio playing (muted for voice activation)");
    status.textContent = "🎵 BabyLink monitoring active";
    alert.hidden = true;
    playAudioBtn.hidden = true;
    logActivity('✅ BabyLink monitoring started', 'unmute');
    
  } catch (err) {
    console.log("⚠️ Autoplay blocked:", err.message);
    showManualPlayOption();
  }
}

function showManualPlayOption() {
  status.textContent = "🔗 Connected - Click start monitoring";
  alert.textContent = "🔊 Click 'Start monitoring' to begin";
  alert.hidden = false;
  playAudioBtn.hidden = false;
  playAudioBtn.style.animation = "pulse 1.5s infinite";
  playAudioBtn.textContent = "🔊 START BABYLINK MONITORING";
}

function createReadyButton() {
  const readyBtn = document.createElement('button');
  readyBtn.textContent = '🔊 READY FOR BABYLINK MONITORING';
  readyBtn.id = 'readyBtn';
  readyBtn.style.cssText = `
    background: #ff5722;
    color: white;
    font-size: 1.5em;
    padding: 1.5em;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    margin: 1em 0;
    animation: pulse 2s infinite;
    width: 100%;
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
  `;
  
  readyBtn.addEventListener('click', async () => {
    console.log("🔊 Parent ready for BabyLink monitoring");
    
    try {
      const silentAudio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmAcBzuU4fPSfC4HKHvL8-');
      await silentAudio.play();
      audioPermissionGranted = true;
      userHasInteracted = true;
      console.log("✅ Audio permission granted");
    } catch (err) {
      console.log("⚠️ Silent audio failed, but continuing:", err);
      audioPermissionGranted = true;
      userHasInteracted = true;
    }
    
    readyBtn.remove();
    createVisualElements();
    status.textContent = "⏳ Waiting for baby...";
    
    socket.emit("join", { roomId, role });
  });
  
  return readyBtn;
}

// Role-specific initialization
if (role === "baby") {
  mic.hidden = false;
  console.log("🎙️ BabyLink baby mode - requesting microphone access");
  
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      console.log("🎙️ Microphone access granted");
      localStream = stream;
      
      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
        console.log("🎵 Audio track added to peer connection");
      });
      
      socket.emit("join", { roomId, role });
      status.textContent = "⏳ Waiting for parent...";
    })
    .catch((err) => {
      console.error("❌ Microphone error:", err);
      alert.textContent = "❌ Microphone access denied";
      alert.hidden = false;
    });
} 
else if (role === "parent") {
  speaker.hidden = false;
  console.log("🔈 BabyLink parent mode - voice activation monitoring");
  
  const readyBtn = createReadyButton();
  controls.appendChild(readyBtn);
  
  status.textContent = "👆 Click READY to start BabyLink monitoring";
  
  // Handle incoming audio stream
  peer.addEventListener("track", (event) => {
    console.log("📥 Audio track received");
    const [stream] = event.streams;
    
    if (stream) {
      remoteAudio.srcObject = stream;
      remoteAudio.volume = 1.0;
      console.log("🔊 Audio stream set to element");
      
      // Initialize voice activity detection
      initializeAudioAnalysis(stream);
      
      // Start with muted audio
      attemptAutoplay();
    }
  });
  
  // Manual play button handler
  playAudioBtn.addEventListener("click", async () => {
    console.log("🔊 Manual BabyLink monitoring start clicked");
    if (remoteAudio.srcObject) {
      try {
        remoteAudio.muted = true;
        isMuted = true;
        await remoteAudio.play();
        console.log("✅ BabyLink monitoring started manually");
        status.textContent = "🎵 BabyLink monitoring active";
        alert.hidden = true;
        playAudioBtn.hidden = true;
        
        if (!isMonitoring) {
          initializeAudioAnalysis(remoteAudio.srcObject);
        }
      } catch (err) {
        console.error("❌ Failed to start monitoring:", err);
        alert.textContent = "❌ Monitoring could not be started";
        alert.hidden = false;
      }
    } else {
      console.warn("⚠️ No audio stream available");
      alert.textContent = "⚠️ No audio received yet";
      alert.hidden = false;
    }
  });
}

// Reset peer connection
function resetPeerConnection() {
  console.log("🔄 Resetting BabyLink peer connection");
  
  // Close old connection
  if (peer) {
    peer.close();
  }
  
  // Create new peer connection
  peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  
  // Re-attach event handlers
  peer.oniceconnectionstatechange = () => {
    console.log("🌐 ICE Connection State:", peer.iceConnectionState);
    
    if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
      console.log("✅ WebRTC connection established");
      integrateBabyLinkWakeLock();
    } else if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
      console.log("❌ WebRTC connection lost");
    }
    
    checkConnectionHealth();
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { candidate: event.candidate });
      console.log("📤 ICE candidate sent");
    }
  };
  
  // Re-add tracks for baby
  if (role === "baby" && localStream) {
    localStream.getTracks().forEach((track) => {
      peer.addTrack(track, localStream);
      console.log("🎵 Audio track re-added to peer connection");
    });
  }
  
  // Re-attach track handler for parent
  if (role === "parent") {
    peer.addEventListener("track", (event) => {
      console.log("📥 Audio track received after reconnection");
      const [stream] = event.streams;
      
      if (stream) {
        remoteAudio.srcObject = stream;
        remoteAudio.volume = 1.0;
        console.log("🔊 Audio stream re-established");
        
        // Re-initialize voice activity detection
        if (audioContext) {
          audioContext.close();
        }
        initializeAudioAnalysis(stream);
        
        // Start with muted audio
        attemptAutoplay();
      }
    });
  }
}

// Connection monitoring
socket.on("connect", () => {
  console.log("✅ Connected to BabyLink server");
  serverConnected = true;
  checkConnectionHealth();
});

socket.on("disconnect", () => {
  console.warn("🚫 BabyLink socket disconnected");
  serverConnected = false;
  status.textContent = "🚫 Connection lost";
  alert.textContent = "🚫 Connection to BabyLink server lost";
  alert.hidden = false;
  
  // Stop monitoring
  isMonitoring = false;
  if (audioContext) {
    audioContext.close();
  }
  
  if (connectionCheckInterval) {
    clearInterval(connectionCheckInterval);
  }
  
  checkConnectionHealth();
});

socket.on("reconnect", () => {
  console.log("🔄 Reconnected to BabyLink server");
  serverConnected = true;
  checkConnectionHealth();
});

// Additional user interaction detection
document.addEventListener('click', () => {
  if (!userHasInteracted) {
    userHasInteracted = true;
    console.log("👆 User interaction detected");
  }
}, { once: true });
