import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { z } from "zod";
import type {
  ChatAck,
  ChatEnvelope,
  ClientToServerEvents,
  ServerToClientEvents
} from "@ac/protocol";

const PORT = Number(process.env.PORT ?? 8787);

// Allow both localhost and 127.0.0.1 dev origins by default
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ??
  "http://127.0.0.1:5173,http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Basic message limits (cheap safety net)
const LIMITS = {
  roomMax: 64,
  fromMax: 64,
  bodyMax: 2048
} as const;

const ChatEnvelopeSchema = z.object({
  id: z.string().min(1),
  room: z.string().min(1).max(LIMITS.roomMax),
  from: z.string().min(1).max(LIMITS.fromMax),
  sentAt: z.number().int().nonnegative(),
  body: z.string().min(1).max(LIMITS.bodyMax)
});

// Simple in-memory dedupe (id -> first-seen timestamp)
const SEEN_MAX = 5000;
const seen = new Map<string, number>();

function seenHas(id: string): boolean {
  return seen.has(id);
}

function seenAdd(id: string): void {
  seen.set(id, Date.now());
  while (seen.size > SEEN_MAX) {
    const oldest = seen.keys().next().value as string | undefined;
    if (!oldest) break;
    seen.delete(oldest);
  }
}

function extractId(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
}

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: CLIENT_ORIGINS, credentials: true }
});

io.on("connection", (socket) => {
  const origin = socket.handshake.headers.origin;
  console.log(`[relay] connect id=${socket.id} origin=${origin ?? "unknown"}`);

  socket.on("disconnect", (reason) => {
    console.log(`[relay] disconnect id=${socket.id} reason=${reason}`);
  });

  socket.on("join", (room) => {
    socket.join(room);
    console.log(`[relay] join id=${socket.id} room=${room}`);
  });

  socket.on("chat", (raw: ChatEnvelope) => {
    const parsed = ChatEnvelopeSchema.safeParse(raw);

    if (!parsed.success) {
      const msgId = extractId(raw);
      const reason = parsed.error.issues[0]?.message ?? "invalid_message";
      console.log(`[relay] reject id=${socket.id} msgId=${msgId} reason=${reason}`);
      socket.emit("chat_ack", { id: msgId, ok: false, reason });
      return;
    }

    const msg = parsed.data;

    // Membership enforcement: must be in the room you're sending to
    if (!socket.rooms.has(msg.room)) {
      console.log(`[relay] deny id=${socket.id} msgId=${msg.id} room=${msg.room} reason=not_in_room`);
      socket.emit("chat_ack", { id: msg.id, ok: false, reason: "not_in_room" });
      return;
    }

    // Dedupe: ack OK but do not rebroadcast
    if (seenHas(msg.id)) {
      console.log(`[relay] dedupe msgId=${msg.id} room=${msg.room} from=${msg.from}`);
      socket.emit("chat_ack", { id: msg.id, ok: true });
      return;
    }

    seenAdd(msg.id);

    console.log(
      `[relay] chat msgId=${msg.id} room=${msg.room} from=${msg.from} sentAt=${msg.sentAt} bytes=${msg.body.length}`
    );

    io.to(msg.room).emit("chat", msg);
    socket.emit("chat_ack", { id: msg.id, ok: true });
  });
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://127.0.0.1:${PORT}`);
  console.log(`[relay] allowing origins ${CLIENT_ORIGINS.join(", ")}`);
});
