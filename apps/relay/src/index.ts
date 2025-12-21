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
  "http://127.0.0.1:5173,http://localhost:5173").split(",");

// Basic message limits (cheap safety net)
const LIMITS = {
  roomMax: 64,
  fromMax: 64,
  bodyMax: 2048
};

const ChatEnvelopeSchema = z.object({
  id: z.string().min(1),
  room: z.string().min(1).max(LIMITS.roomMax),
  from: z.string().min(1).max(LIMITS.fromMax),
  sentAt: z.number().int().nonnegative(),
  body: z.string().min(1).max(LIMITS.bodyMax)
});

// Simple in-memory dedupe
const SEEN_MAX = 5000;
const seen = new Map<string, number>(); // id -> ts

function seenHas(id: string): boolean {
  return seen.has(id);
}

function seenAdd(id: string): void {
  seen.set(id, Date.now());
  if (seen.size > SEEN_MAX) {
    const firstKey = seen.keys().next().value as string | undefined;
    if (firstKey) seen.delete(firstKey);
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
  socket.on("join", (room) => {
    // v0: no auth/membership yet
    socket.join(room);
  });

  socket.on("chat", (raw: ChatEnvelope) => {
    const parsed = ChatEnvelopeSchema.safeParse(raw);

    if (!parsed.success) {
      const ack: ChatAck = {
        id: extractId(raw),
        ok: false,
        reason: parsed.error.issues[0]?.message ?? "invalid_message"
      };
      socket.emit("chat_ack", ack);
      return;
    }

    const msg = parsed.data;

    // Dedupe: ack OK but do not rebroadcast
    if (seenHas(msg.id)) {
      socket.emit("chat_ack", { id: msg.id, ok: true });
      return;
    }

    seenAdd(msg.id);

    io.to(msg.room).emit("chat", msg);
    socket.emit("chat_ack", { id: msg.id, ok: true });
  });
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://127.0.0.1:${PORT}`);
  console.log(`[relay] allowing origins ${CLIENT_ORIGINS.join(", ")}`);
});
