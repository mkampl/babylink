// server.js
const fs = require("fs");
const https = require("https");
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const { Server } = require("socket.io");

const app = express();
const options = {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("cert.pem"),
};

const server = https.createServer(options, app);
const io = new Server(server);

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
  socket.on("join", ({ roomId, role }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = role;
    console.log(`Client ${socket.id} joined room ${roomId} as ${role}`);
  });

  socket.on("signal", (data) => {
    socket.to(socket.roomId).emit("signal", data);
  });

  socket.on("disconnect", () => {
    console.log(`Client ${socket.id} disconnected`);
  });
});

server.listen(3000, () => {
  console.log("HTTPS Server running at https://localhost:3000");
});

