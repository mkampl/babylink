// public/client.js
const socket = io();
const params = new URLSearchParams(window.location.search);
const role = params.get("role") || "parent";
const roomId = window.location.pathname.slice(1);
const remoteAudio = document.getElementById("remoteAudio");
const status = document.getElementById("status");
const mic = document.getElementById("mic");
const speaker = document.getElementById("speaker");
const alert = document.getElementById("alert");
const playAudioBtn = document.getElementById("playAudio");

let peer = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});

let localStream = null;

peer.oniceconnectionstatechange = () => {
  console.log("🌐 ICE-Status:", peer.iceConnectionState);
};

peer.onicecandidate = (event) => {
  if (event.candidate) {
    socket.emit("signal", { candidate: event.candidate });
    console.log("📤 ICE-Kandidat gesendet:", event.candidate);
  }
};

socket.on("signal", async (data) => {
  console.log("📡 Signal empfangen:", data);
  try {
    if (data.offer) {
      await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("signal", { answer });
      console.log("📤 Antwort gesendet");
    } else if (data.answer) {
      await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
      console.log("📥 Antwort gesetzt");
    } else if (data.candidate) {
      await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log("📥 Kandidat hinzugefügt");
    }
  } catch (error) {
    console.error("❌ Fehler beim Verarbeiten des Signals:", error);
  }
});

// Server tells baby to start offer when parent connects
socket.on("start-offer", async () => {
  if (role === "baby" && localStream) {
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("signal", { offer });
      console.log("📤 Angebot nach Aufforderung gesendet");
    } catch (err) {
      console.error("❌ Fehler beim Erstellen des Angebots:", err);
    }
  }
});

if (role === "baby") {
  mic.hidden = false;
  console.log("🎙️ Baby-Stream start");
  
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      console.log("🎙️ Baby-Stream bereit:", stream);
      localStream = stream;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      
      // Join the room after getting the stream
      socket.emit("join", { roomId, role });
      status.textContent = "🔗 Warten auf Eltern...";
    })
    .catch((err) => {
      console.error("❌ Mikrofonfehler:", err);
      alert.textContent = "❌ Mikrofonfehler";
      alert.hidden = false;
    });

  // Add negotiation handler back as fallback
  peer.onnegotiationneeded = async () => {
    try {
      console.log("🔄 Negotiation needed triggered");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("signal", { offer });
      console.log("📤 Automatisches Angebot gesendet");
    } catch (err) {
      console.error("❌ Fehler bei automatischer Verhandlung:", err);
    }
  };
}

if (role === "parent") {
  speaker.hidden = false;
  playAudioBtn.hidden = false;
  
  // Parent joins immediately
  socket.emit("join", { roomId, role });
  status.textContent = "🔗 Warten auf Baby...";
  
  playAudioBtn.addEventListener("click", () => {
    if (remoteAudio.srcObject) {
      remoteAudio.play()
        .then(() => {
          console.log("✅ Audio manuell gestartet");
          status.textContent = "🔗 Verbindung hergestellt - Audio läuft";
          alert.hidden = true;
        })
        .catch((err) => {
          console.error("🔇 Audio abspielen fehlgeschlagen:", err);
          alert.textContent = "❌ Audio konnte nicht abgespielt werden";
          alert.hidden = false;
        });
    } else {
      console.warn("🔇 Kein Stream verfügbar zum Abspielen");
      alert.textContent = "🔇 Noch kein Audio-Stream empfangen";
      alert.hidden = false;
    }
  });
  
  peer.addEventListener("track", (event) => {
    console.log("📥 Track empfangen auf Elternseite:", event.streams);
    const [stream] = event.streams;
    remoteAudio.srcObject = stream;
    remoteAudio.volume = 1.0; // Ensure volume is at maximum
    
    // Try to play immediately
    remoteAudio.play()
      .then(() => {
        console.log("✅ Audio spielt automatisch");
        status.textContent = "🔗 Verbindung hergestellt - Audio läuft";
      })
      .catch((err) => {
        console.log("⚠️ Autoplay blockiert:", err.message);
        status.textContent = "🔗 Verbindung hergestellt - Klicke Play-Button";
        alert.textContent = "🔊 Klicke den Play-Button um Audio zu hören";
        alert.hidden = false;
      });
  });
}

socket.on("disconnect", () => {
  console.warn("🚫 Verbindung verloren");
  status.textContent = "🚫 Verbindung getrennt";
  alert.textContent = "🚫 Verbindung getrennt";
  alert.hidden = false;
});
