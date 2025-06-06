// public/client.js
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

// Voice Activity Detection für Parent
let audioContext = null;
let analyser = null;
let dataArray = null;
let source = null;
let isMonitoring = false;

// Audio Level Thresholds (0-255)
const LEVELS = {
  GREEN: { min: 0, max: 30, name: "Ruhe", color: "#4CAF50" },
  YELLOW: { min: 31, max: 80, name: "Bewegung", color: "#FFC107" },
  RED: { min: 81, max: 255, name: "Weinen", color: "#F44336" }
};

// Timing states
let currentLevel = 'GREEN';
let levelStartTime = Date.now();
let isMuted = true;
let yellowTimer = null;
let redTimer = null;

// Visual elements
let levelIndicator = null;
let volumeMeter = null;

// Peer connection event handlers
peer.oniceconnectionstatechange = () => {
  console.log("🌐 ICE Connection State:", peer.iceConnectionState);
  if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
    console.log("✅ WebRTC connection established");
  }
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
  console.log(`👤 ${joinedRole} joined room`);
  updateConnectionStatus(participants);
  
  if (role === "baby" && joinedRole === "parent" && localStream) {
    console.log("🎙️ Parent joined, baby initiating connection");
    initiateConnection();
  }
});

socket.on("participant-left", ({ role: leftRole, participants }) => {
  console.log(`👤 ${leftRole} left room`);
  updateConnectionStatus(participants);
});

socket.on("room-state", ({ participants }) => {
  console.log("🏠 Room state:", participants.map(p => p.role));
  updateConnectionStatus(participants);
  
  if (role === "baby" && participants.some(p => p.role === "parent") && localStream) {
    console.log("🎙️ Parent already present, baby initiating connection");
    setTimeout(initiateConnection, 1000);
  }
});

function updateConnectionStatus(participants) {
  const hasParent = participants.some(p => p.role === "parent");
  const hasBaby = participants.some(p => p.role === "baby");
  
  remoteRoleConnected = role === "baby" ? hasParent : hasBaby;
  
  if (hasParent && hasBaby) {
    status.textContent = "🔗 Beide Geräte verbunden";
  } else if (role === "baby") {
    status.textContent = hasParent ? "🔗 Eltern gefunden, verbinde..." : "⏳ Warte auf Eltern...";
  } else {
    status.textContent = hasBaby ? "🔗 Baby gefunden, verbinde..." : "⏳ Warte auf Baby...";
  }
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
  levelIndicator.textContent = `🟢 ${LEVELS.GREEN.name} - Audio stumm`;
  
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
    <strong>🎵 Lautstärke-Überwachung:</strong><br>
    🟢 <strong>Ruhe:</strong> Audio stumm<br>
    🟡 <strong>Bewegung:</strong> Aktivierung nach 5 Sek.<br>
    🔴 <strong>Weinen:</strong> Sofortige Aktivierung
  `;
  
  controls.appendChild(levelIndicator);
  controls.appendChild(volumeMeter);
  controls.appendChild(infoPanel);
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
    
    console.log("🎵 Audio analysis initialized");
    startMonitoring();
    
  } catch (error) {
    console.error("❌ Audio analysis setup failed:", error);
  }
}

function startMonitoring() {
  if (!isMonitoring) {
    isMonitoring = true;
    monitorAudioLevel();
    console.log("👂 Audio monitoring started");
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
  
  currentLevel = newLevel;
  levelStartTime = Date.now();
  
  // Clear existing timers
  if (yellowTimer) clearTimeout(yellowTimer);
  if (redTimer) clearTimeout(redTimer);
  
  // Update visual indicator
  updateLevelIndicator(newLevel);
  
  // Handle audio muting/unmuting
  switch (newLevel) {
    case 'GREEN':
      // Mute after delay if coming from yellow/red
      if (!isMuted) {
        const delay = currentLevel === 'RED' ? 10000 : 5000; // 10s for red, 5s for yellow
        setTimeout(() => {
          if (currentLevel === 'GREEN') {
            muteAudio();
          }
        }, delay);
      }
      break;
      
    case 'YELLOW':
      // Unmute after 5 seconds
      yellowTimer = setTimeout(() => {
        if (currentLevel === 'YELLOW') {
          unmuteAudio();
        }
      }, 5000);
      break;
      
    case 'RED':
      // Immediate unmute
      unmuteAudio();
      break;
  }
}

function updateLevelIndicator(level) {
  if (!levelIndicator) return;
  
  const levelInfo = LEVELS[level];
  const emoji = level === 'GREEN' ? '🟢' : level === 'YELLOW' ? '🟡' : '🔴';
  const muteStatus = isMuted ? 'Audio stumm' : 'Audio aktiv';
  
  levelIndicator.style.background = levelInfo.color;
  levelIndicator.textContent = `${emoji} ${levelInfo.name} - ${muteStatus}`;
}

function muteAudio() {
  if (remoteAudio && !isMuted) {
    remoteAudio.muted = true;
    isMuted = true;
    console.log("🔇 Audio muted");
    updateLevelIndicator(currentLevel);
  }
}

function unmuteAudio() {
  if (remoteAudio && isMuted) {
    remoteAudio.muted = false;
    isMuted = false;
    console.log("🔊 Audio unmuted");
    updateLevelIndicator(currentLevel);
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
    status.textContent = "🎵 Audio-Überwachung aktiv";
    alert.hidden = true;
    playAudioBtn.hidden = true;
    
  } catch (err) {
    console.log("⚠️ Autoplay blocked:", err.message);
    showManualPlayOption();
  }
}

function showManualPlayOption() {
  status.textContent = "🔗 Verbunden - Klicke Audio starten";
  alert.textContent = "🔊 Klicke 'Audio starten' für Überwachung";
  alert.hidden = false;
  playAudioBtn.hidden = false;
  playAudioBtn.style.animation = "pulse 1.5s infinite";
  playAudioBtn.textContent = "🔊 ÜBERWACHUNG STARTEN";
}

function createReadyButton() {
  const readyBtn = document.createElement('button');
  readyBtn.textContent = '🔊 BEREIT FÜR BABY-ÜBERWACHUNG';
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
    console.log("🔊 Parent ready for audio monitoring");
    
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
    status.textContent = "⏳ Warte auf Baby...";
    
    socket.emit("join", { roomId, role });
  });
  
  return readyBtn;
}

// Role-specific initialization
if (role === "baby") {
  mic.hidden = false;
  console.log("🎙️ Baby mode - requesting microphone access");
  
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      console.log("🎙️ Microphone access granted");
      localStream = stream;
      
      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
        console.log("🎵 Audio track added to peer connection");
      });
      
      socket.emit("join", { roomId, role });
      status.textContent = "⏳ Warte auf Eltern...";
    })
    .catch((err) => {
      console.error("❌ Microphone error:", err);
      alert.textContent = "❌ Mikrofon-Zugriff verweigert";
      alert.hidden = false;
    });
} 
else if (role === "parent") {
  speaker.hidden = false;
  console.log("🔈 Parent mode - voice activation monitoring");
  
  const readyBtn = createReadyButton();
  controls.appendChild(readyBtn);
  
  status.textContent = "👆 Klicke BEREIT um Überwachung zu starten";
  
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
    console.log("🔊 Manual monitoring start clicked");
    if (remoteAudio.srcObject) {
      try {
        remoteAudio.muted = true;
        isMuted = true;
        await remoteAudio.play();
        console.log("✅ Audio monitoring started manually");
        status.textContent = "🎵 Audio-Überwachung aktiv";
        alert.hidden = true;
        playAudioBtn.hidden = true;
        
        if (!isMonitoring) {
          initializeAudioAnalysis(remoteAudio.srcObject);
        }
      } catch (err) {
        console.error("❌ Failed to start monitoring:", err);
        alert.textContent = "❌ Überwachung konnte nicht gestartet werden";
        alert.hidden = false;
      }
    } else {
      console.warn("⚠️ No audio stream available");
      alert.textContent = "⚠️ Noch kein Audio empfangen";
      alert.hidden = false;
    }
  });
}

// Connection lost handler
socket.on("disconnect", () => {
  console.warn("🚫 Socket disconnected");
  status.textContent = "🚫 Verbindung getrennt";
  alert.textContent = "🚫 Verbindung zum Server verloren";
  alert.hidden = false;
  
  // Stop monitoring
  isMonitoring = false;
  if (audioContext) {
    audioContext.close();
  }
});

// Additional user interaction detection
document.addEventListener('click', () => {
  if (!userHasInteracted) {
    userHasInteracted = true;
    console.log("👆 User interaction detected");
  }
}, { once: true });
