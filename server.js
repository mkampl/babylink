const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("Client verbunden:", socket.id);

  socket.on("signal", (data) => {
    socket.broadcast.emit("signal", data); // sendet an andere Teilnehmer
  });

  socket.on("disconnect", () => {
    console.log("Client getrennt:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server läuft auf http://localhost:3000");
});

