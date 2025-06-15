// server-http.js - HTTP version for when no SSL certificates are available
const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Track rooms and their participants
const rooms = new Map();

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

app.get("/:roomId", (req, res) => {
  const { role } = req.query;
  if (role === "baby" || role === "parent") {
    res.sendFile(path.join(__dirname, "views", "webrtc.html"));
  } else {
    res.sendFile(path.join(__dirname, "views", "select-role.html"));
  }
});

app.post("/:roomId", (req, res) => {
  const { roomId } = req.params;
  const { role } = req.body;
  res.redirect(`/${encodeURIComponent(roomId)}?role=${encodeURIComponent(role)}`);
});

io.on("connection", (socket) => {
  console.log(`Client ${socket.id} connected`);

  socket.on("join", ({ roomId, role }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = role;
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { participants: [] });
    }
    
    const room = rooms.get(roomId);
    
    // Remove any existing entry for this socket
    room.participants = room.participants.filter(p => p.socketId !== socket.id);
    
    // Add current participant
    room.participants.push({ socketId: socket.id, role });
    
    console.log(`Client ${socket.id} joined room ${roomId} as ${role}`);
    console.log(`Room ${roomId} participants:`, room.participants.map(p => p.role));
    
    // Notify all participants in the room about the new joiner
    socket.to(roomId).emit("participant-joined", { role, participants: room.participants });
    
    // Send current participants to the new joiner
    socket.emit("room-state", { participants: room.participants });
  });

  socket.on("signal", (data) => {
    console.log(`Signal from ${socket.id} (${socket.role}):`, Object.keys(data));
    socket.to(socket.roomId).emit("signal", {
      ...data,
      from: socket.role
    });
  });

  socket.on("disconnect", () => {
    console.log(`Client ${socket.id} disconnected`);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.participants = room.participants.filter(p => p.socketId !== socket.id);
        
        // Notify remaining participants
        socket.to(socket.roomId).emit("participant-left", { 
          role: socket.role,
          participants: room.participants 
        });
        
        // Clean up empty rooms
        if (room.participants.length === 0) {
          rooms.delete(socket.roomId);
          console.log(`Room ${socket.roomId} deleted (empty)`);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`HTTP Server running at http://localhost:${PORT}`);
  console.log(`⚠️  Running in HTTP mode - no SSL certificates found`);
});
