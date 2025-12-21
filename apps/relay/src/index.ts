import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import type { ChatEnvelope, ClientToServerEvents, ServerToClientEvents } from "@ac/protocol";

const PORT = Number(process.env.PORT ?? 8787);

// Allow both localhost and 127.0.0.1 dev origins by default
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ??
  "http://127.0.0.1:5173,http://localhost:5173").split(",");

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: CLIENT_ORIGINS, credentials: true }
});

io.on("connection", (socket) => {
  socket.on("join", (room) => {
    socket.join(room);
  });

  socket.on("chat", (msg: ChatEnvelope) => {
    io.to(msg.room).emit("chat", msg);
  });
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://127.0.0.1:${PORT}`);
  console.log(`[relay] allowing origins ${CLIENT_ORIGINS.join(", ")}`);
});
