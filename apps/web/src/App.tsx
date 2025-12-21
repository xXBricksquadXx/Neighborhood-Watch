import { useEffect, useRef, useState } from "react";
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

type ChatItem = ChatEnvelope & {
  delivery?: Delivery;
  error?: string;
};

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
  const [room, setRoom] = useState("family");
  const [from, setFrom] = useState("laptop");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatItem[]>([]);

  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState("");
  const [transport, setTransport] = useState<string>("");

  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const roomRef = useRef(room);

  // Delivery tracking
  const pendingIdsRef = useRef(new Set<string>());
  const pendingMapRef = useRef(new Map<string, ChatEnvelope>()); // id -> envelope
  const seenRef = useRef(new Set<string>());

  // retry bookkeeping
  const attemptRef = useRef(new Map<string, number>()); // id -> attempts
  const RETRY_MAX = 5;

  // Keep latest room for connect handler + allow room changes while connected
  useEffect(() => {
    roomRef.current = room;
    const s = socketRef.current;
    if (s?.connected) s.emit("join", room);
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

    const flushPending = () => {
      // Ensure we are joined to the current room before resending
      s.emit("join", roomRef.current);

      for (const id of pendingIdsRef.current) {
        const env = pendingMapRef.current.get(id);
        if (!env) continue;

        const attempts = (attemptRef.current.get(id) ?? 0) + 1;
        attemptRef.current.set(id, attempts);

        if (attempts > RETRY_MAX) {
          // Mark as failed locally
          pendingIdsRef.current.delete(id);
          pendingMapRef.current.delete(id);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === id ? { ...m, delivery: "failed", error: "retry_limit" } : m
            )
          );
          continue;
        }

        // Re-emit
        s.emit("chat", env);
      }
    };

    s.on("connect", () => {
      setStatus("connected");
      setStatusDetail("");
      setFromEngine();

      // join and retry
      s.emit("join", roomRef.current);
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

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === msg.id);
        if (idx === -1) return [...prev, { ...msg, delivery: "sent" }];

        const copy = prev.slice();
        copy[idx] = { ...copy[idx], ...msg, delivery: "sent", error: "" };
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

    // Track pending
    pendingIdsRef.current.add(env.id);
    pendingMapRef.current.set(env.id, env);
    attemptRef.current.set(env.id, 0);

    // optimistic add
    setMessages((prev) => [...prev, { ...env, delivery: "pending" }]);

    // Ensure membership for current room
    s.emit("join", room);

    // send
    s.emit("chat", env);
    setText("");
  }

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", fontFamily: "system-ui" }}>
      <h1>N̷e̷i̷g̷h̷b̷o̷r̷h̷o̷o̷d̷ W̷a̷t̷c̷h̷ </h1>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Room <input value={room} onChange={(e) => setRoom(e.target.value)} />
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
        {messages.map((m) => (
          <div key={m.id} style={{ padding: "8px 0", borderBottom: "1px solid #ddd" }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              [{m.room}] {m.from} • {new Date(m.sentAt).toLocaleTimeString()}
              {m.delivery ? ` • ${m.delivery}` : ""}
              {m.delivery === "failed" && m.error ? ` (${m.error})` : ""}
            </div>
            <div>{m.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
