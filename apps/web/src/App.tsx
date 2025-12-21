// apps/web/src/App.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ChatAck,
  ChatEnvelope,
  ClientToServerEvents,
  ServerToClientEvents
} from "@ac/protocol";

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "http://127.0.0.1:8787";

function uuid(): string {
  return crypto.randomUUID();
}

type ConnStatus = "connecting" | "connected" | "disconnected" | "error";
type Delivery = "pending" | "sent" | "failed";
type Direction = "outgoing" | "incoming";

type ChatItem = ChatEnvelope & {
  delivery?: Delivery; // only meaningful for outgoing
  error?: string; // only meaningful for outgoing
  direction?: Direction; // incoming/outgoing for UI labeling
};

const ROOM_PRESETS = [
  { value: "emergency", label: "Emergency" },
  { value: "family", label: "Family" },
  { value: "vacant-1", label: "Vacant Room 1" },
  { value: "vacant-2", label: "Vacant Room 2" },
  { value: "vacant-3", label: "Vacant Room 3" },
  { value: "vacant-4", label: "Vacant Room 4" }
] as const;

// engine.io internals: dev-only visibility without `any`
type EngineEvent = "upgrade" | "transport";
type EngineLike = {
  transport?: { name?: string };
  on?: (event: EngineEvent, cb: (arg: unknown) => void) => void;
  off?: (event: EngineEvent, cb: (arg: unknown) => void) => void;
};

function readName(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const name = (v as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

export default function App() {
  const [roomPreset, setRoomPreset] =
    useState<(typeof ROOM_PRESETS)[number]["value"]>("family");
  const [from, setFrom] = useState("laptop");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatItem[]>([]);

  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState("");
  const [transport, setTransport] = useState<string>("");

  const room = roomPreset;

  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const roomRef = useRef(room);

  // join de-dupe (what we last asked the relay to join)
  const lastJoinedRoomRef = useRef<string>("");

  // Delivery tracking
  const pendingIdsRef = useRef(new Set<string>());
  const pendingMapRef = useRef(new Map<string, ChatEnvelope>()); // id -> envelope

  // retry bookkeeping
  const attemptRef = useRef(new Map<string, number>()); // id -> attempts
  const RETRY_MAX = 5;

  // Dedupe receive
  const seenRef = useRef(new Set<string>());

  // Track ids created locally (for incoming/outgoing labeling)
  const localIdsRef = useRef(new Set<string>());

  const visibleMessages = useMemo(() => {
    // only show active room
    return messages.filter((m) => m.room === room);
  }, [messages, room]);

  // keep latest room for connect handler + allow room changes while connected
  useEffect(() => {
    roomRef.current = room;

    const s = socketRef.current;
    if (!s?.connected) return;

    if (lastJoinedRoomRef.current !== room) {
      s.emit("join", room);
      lastJoinedRoomRef.current = room;
    }
  }, [room]);

  useEffect(() => {
    const s = io(RELAY_URL, {
      transports: ["websocket", "polling"],
      withCredentials: true
    });

    socketRef.current = s;

    const engine = (s.io as unknown as { engine?: EngineLike }).engine;

    const setFromEngine = () => {
      const name = engine?.transport?.name;
      if (typeof name === "string") setTransport(name);
    };

    const onEngineEvent = (arg: unknown) => {
      const name = readName(arg);
      if (name) setTransport(name);
      else setFromEngine();
    };

    const ensureJoined = (r: string) => {
      if (!s.connected) return;
      if (lastJoinedRoomRef.current === r) return;
      s.emit("join", r);
      lastJoinedRoomRef.current = r;
    };

    const flushPending = () => {
      // Group pending by room (in case user switched rooms while offline)
      const byRoom = new Map<string, ChatEnvelope[]>();
      for (const id of pendingIdsRef.current) {
        const env = pendingMapRef.current.get(id);
        if (!env) continue;
        const arr = byRoom.get(env.room) ?? [];
        arr.push(env);
        byRoom.set(env.room, arr);
      }

      for (const [r, envs] of byRoom) {
        ensureJoined(r);

        for (const env of envs) {
          const attempts = (attemptRef.current.get(env.id) ?? 0) + 1;
          attemptRef.current.set(env.id, attempts);

          if (attempts > RETRY_MAX) {
            pendingIdsRef.current.delete(env.id);
            pendingMapRef.current.delete(env.id);
            attemptRef.current.delete(env.id);

            setMessages((prev) =>
              prev.map((m) =>
                m.id === env.id
                  ? { ...m, delivery: "failed", error: "retry_limit" }
                  : m
              )
            );
            continue;
          }

          s.emit("chat", env);
        }
      }

      // Return to active room
      ensureJoined(roomRef.current);
    };

    s.on("connect", () => {
      setStatus("connected");
      setStatusDetail("");
      setFromEngine();

      // relay restart => our previous room membership is gone
      lastJoinedRoomRef.current = "";
      ensureJoined(roomRef.current);

      flushPending();
    });

    s.on("disconnect", (reason) => {
      setStatus("disconnected");
      setStatusDetail(reason ?? "");
    });

    s.on("connect_error", (err) => {
      setStatus("error");
      setStatusDetail(err?.message ?? String(err));
    });

    s.on("chat_ack", (ack: ChatAck) => {
      if (!ack?.id) return;

      pendingIdsRef.current.delete(ack.id);
      pendingMapRef.current.delete(ack.id);
      attemptRef.current.delete(ack.id);

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== ack.id) return m;
          if (ack.ok) return { ...m, delivery: "sent", error: "" };
          return { ...m, delivery: "failed", error: ack.reason ?? "rejected" };
        })
      );
    });

    s.on("chat", (msg: ChatEnvelope) => {
      // Dedupe receive
      if (seenRef.current.has(msg.id)) return;
      seenRef.current.add(msg.id);

      // Determine direction ONCE (do not read refs during render)
      const isLocal = localIdsRef.current.has(msg.id);
      const patch: Partial<ChatItem> = isLocal
        ? { direction: "outgoing" }
        : { direction: "incoming", delivery: undefined, error: "" };

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msg.id);
        if (idx === -1) return [...prev, { ...msg, ...patch }];

        const copy = prev.slice();
        copy[idx] = { ...copy[idx], ...msg, ...patch };
        return copy;
      });
    });

    engine?.on?.("upgrade", onEngineEvent);
    engine?.on?.("transport", onEngineEvent);

    return () => {
      engine?.off?.("upgrade", onEngineEvent);
      engine?.off?.("transport", onEngineEvent);
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  function send() {
    const s = socketRef.current;
    if (!s) return;

    const body = text.trim();
    if (!body) return;

    const env: ChatEnvelope = {
      id: uuid(),
      room,
      from,
      sentAt: Date.now(),
      body
    };

    // Mark id as locally created (for received vs sent labeling)
    localIdsRef.current.add(env.id);

    // Track pending
    pendingIdsRef.current.add(env.id);
    pendingMapRef.current.set(env.id, env);
    attemptRef.current.set(env.id, 0);

    // optimistic add (direction set here, so render doesn't read refs)
    setMessages((prev) => [
      ...prev,
      { ...env, delivery: "pending", direction: "outgoing" }
    ]);

    // Ensure membership for active room
    if (s.connected && lastJoinedRoomRef.current !== room) {
      s.emit("join", room);
      lastJoinedRoomRef.current = room;
    }

    s.emit("chat", env);
    setText("");
  }

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", fontFamily: "system-ui" }}>
      <h1>N̷e̷i̷g̷h̷b̷o̷r̷h̷o̷o̷d̷ W̷a̷t̷c̷h̷</h1>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Room{" "}
          <select value={roomPreset} onChange={(e) => setRoomPreset(e.target.value as any)}>
            {ROOM_PRESETS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          From <input value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <div>
          Status: <b>{status}</b>
          {transport ? <span style={{ opacity: 0.7 }}> (transport: {transport})</span> : null}
          {statusDetail ? <span style={{ opacity: 0.7 }}> ({statusDetail})</span> : null}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type a message…"
        />
        <button onClick={send} disabled={status !== "connected"}>
          Send
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        {visibleMessages.map((m) => {
          const label =
            m.direction === "incoming"
              ? "received"
              : m.delivery
                ? m.delivery
                : "sent";

          return (
            <div key={m.id} style={{ padding: "8px 0", borderBottom: "1px solid #ddd" }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                [{m.room}] {m.from} • {new Date(m.sentAt).toLocaleTimeString()} • {label}
                {label === "failed" && m.error ? ` (${m.error})` : ""}
              </div>
              <div>{m.body}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
