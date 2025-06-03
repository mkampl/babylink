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
});

if (role === "baby") {
  mic.hidden = false;
  console.log("🎙️ Baby-Stream start");

  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    console.log("🎙️ Baby-Stream bereit:", stream);

    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    // erst jetzt dem Server mitteilen, dass wir beitreten
    socket.emit("join", { roomId, role });
    status.textContent = "🔗 Verbindung hergestellt";

  }).catch((err) => {
    console.error("❌ Mikrofonfehler:", err);
    alert.textContent = "❌ Mikrofonfehler";
    alert.hidden = false;
  });

  peer.onnegotiationneeded = async () => {
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("signal", { offer });
      console.log("📤 Angebot gesendet");
    } catch (err) {
      console.error("❌ Fehler bei Verhandlungsstart:", err);
    }
  };
}

if (role === "parent") {
  speaker.hidden = false;
  playAudioBtn.hidden = false;

  socket.emit("join", { roomId, role }); // Parent kann direkt joinen

  playAudioBtn.addEventListener("click", () => {
    if (remoteAudio.srcObject) {
      remoteAudio.play().catch((err) => {
        console.error("🔇 Audio abspielen fehlgeschlagen:", err);
      });
    } else {
      console.warn("🔇 Kein Stream verfügbar zum Abspielen");
    }
  });

  peer.addEventListener("track", (event) => {
    console.log("📥 Track empfangen auf Elternseite:", event.streams);
    const [stream] = event.streams;
    remoteAudio.srcObject = stream;
  });

  status.textContent = "🔗 Verbindung hergestellt";
}

socket.on("disconnect", () => {
  console.warn("🚫 Verbindung verloren");
  status.textContent = "🚫 Verbindung getrennt";
  alert.textContent = "🚫 Verbindung getrennt";
  alert.hidden = false;
});

