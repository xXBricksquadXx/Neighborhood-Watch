import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { z } from "zod";
import type {
  ChatAck,
  ChatEnvelope,
  ClientToServerEvents,
  JoinAck,
  ServerToClientEvents
} from "@ac/protocol";

const PORT = Number(process.env.PORT ?? 8787);

const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ??
  "http://127.0.0.1:5173,http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const INVITE_TOKENS = new Set(
  (process.env.INVITE_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const REQUIRE_INVITE = INVITE_TOKENS.size > 0;

const DEFAULT_ROOMS = [
  "emergency",
  "family",
  "vacant-1",
  "vacant-2",
  "vacant-3",
  "vacant-4"
] as const;

const ALLOWED_ROOMS = new Set(
  (process.env.ALLOWED_ROOMS ?? DEFAULT_ROOMS.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function allowedRoomsList(): string[] {
  return Array.from(ALLOWED_ROOMS).sort();
}

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

function normalizeRoom(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

function extractId(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
}

// Simple dedupe (process-level)
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

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: CLIENT_ORIGINS, credentials: true }
});

io.use((socket, next) => {
  if (!REQUIRE_INVITE) return next();

  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  const token = typeof auth?.token === "string" ? auth.token : "";

  if (!token || !INVITE_TOKENS.has(token)) {
    return next(new Error("unauthorized"));
  }

  return next();
});

io.on("connection", (socket) => {
  const origin = socket.handshake.headers.origin;
  console.log(`[relay] connect id=${socket.id} origin=${origin ?? "unknown"}`);

  if (REQUIRE_INVITE) {
    console.log(`[relay] invite-only enabled (tokens=${INVITE_TOKENS.size})`);
  }
  console.log(`[relay] rooms: ${allowedRoomsList().join(", ")}`);

  socket.on("disconnect", (reason) => {
    console.log(`[relay] disconnect id=${socket.id} reason=${reason}`);
  });

  socket.on("join", (rawRoom, ack) => {
    const room = normalizeRoom(rawRoom);

    if (!room || room.length > LIMITS.roomMax) {
      const res: JoinAck = {
        room: room || "",
        ok: false,
        reason: "invalid_room",
        allowedRooms: allowedRoomsList()
      };
      console.log(
        `[relay] join-deny id=${socket.id} room=${String(rawRoom)} reason=invalid_room`
      );
      ack?.(res);
      return;
    }

    if (!ALLOWED_ROOMS.has(room)) {
      const res: JoinAck = {
        room,
        ok: false,
        reason: "room_not_allowed",
        allowedRooms: allowedRoomsList()
      };
      console.log(
        `[relay] join-deny id=${socket.id} room=${room} reason=room_not_allowed`
      );
      ack?.(res);
      return;
    }

    socket.join(room);
    console.log(`[relay] join id=${socket.id} room=${room}`);
    ack?.({ room, ok: true });
  });

  socket.on("chat", (raw: ChatEnvelope) => {
    const parsed = ChatEnvelopeSchema.safeParse(raw);

    if (!parsed.success) {
      const msgId = extractId(raw);
      const reason = parsed.error.issues[0]?.message ?? "invalid_message";
      console.log(`[relay] reject id=${socket.id} msgId=${msgId} reason=${reason}`);
      const ack: ChatAck = { id: msgId, ok: false, reason };
      socket.emit("chat_ack", ack);
      return;
    }

    const msg = parsed.data;
    const targetRoom = msg.room.trim().toLowerCase();

    if (!ALLOWED_ROOMS.has(targetRoom)) {
      console.log(
        `[relay] deny id=${socket.id} msgId=${msg.id} room=${targetRoom} reason=room_not_allowed`
      );
      socket.emit("chat_ack", { id: msg.id, ok: false, reason: "room_not_allowed" });
      return;
    }

    if (!socket.rooms.has(targetRoom)) {
      console.log(
        `[relay] deny id=${socket.id} msgId=${msg.id} room=${targetRoom} reason=not_in_room`
      );
      socket.emit("chat_ack", { id: msg.id, ok: false, reason: "not_in_room" });
      return;
    }

    if (seenHas(msg.id)) {
      console.log(`[relay] dedupe msgId=${msg.id} room=${targetRoom} from=${msg.from}`);
      socket.emit("chat_ack", { id: msg.id, ok: true });
      return;
    }

    seenAdd(msg.id);

    console.log(
      `[relay] chat msgId=${msg.id} room=${targetRoom} from=${msg.from} sentAt=${msg.sentAt} bytes=${msg.body.length}`
    );

    io.to(targetRoom).emit("chat", { ...msg, room: targetRoom });
    socket.emit("chat_ack", { id: msg.id, ok: true });
  });
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://127.0.0.1:${PORT}`);
  console.log(`[relay] allowing origins ${CLIENT_ORIGINS.join(", ")}`);
});
