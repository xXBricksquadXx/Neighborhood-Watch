import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ChatAck,
  ChatEnvelope,
  ClientToServerEvents,
  JoinAck,
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
  delivery?: Delivery;
  error?: string;
  direction?: Direction; // set in handlers (never computed from refs in render)
};

const ROOM_PRESETS = [
  { value: "emergency", label: "Emergency" },
  { value: "family", label: "Family" },
  { value: "vacant-1", label: "Vacant Room 1" },
  { value: "vacant-2", label: "Vacant Room 2" },
  { value: "vacant-3", label: "Vacant Room 3" },
  { value: "vacant-4", label: "Vacant Room 4" }
] as const;

type RoomId = (typeof ROOM_PRESETS)[number]["value"];

const ROOM_LOOKUP = new Map<string, RoomId>(
  ROOM_PRESETS.flatMap((r) => [
    [r.value.toLowerCase(), r.value],
    [r.label.toLowerCase(), r.value]
  ])
);

function normalizeRoomFromUrl(raw: string | null | undefined): RoomId | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return ROOM_LOOKUP.get(key) ?? null;
}

function getInitialRoom(): RoomId {
  const params = new URLSearchParams(window.location.search);
  return normalizeRoomFromUrl(params.get("room")) ?? "family";
}

function getInitialToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? (import.meta.env.VITE_INVITE_TOKEN as string | undefined) ?? "";
}

// engine.io internals (dev visibility)
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

type RoomJoinState =
  | { room: string; phase: "unknown" }
  | { room: string; phase: "joining" }
  | { room: string; phase: "joined" }
  | { room: string; phase: "denied"; reason: string; allowedRooms?: string[] };

export default function App() {
  const [roomPreset, setRoomPreset] = useState<RoomId>(() => getInitialRoom());
  const [token] = useState<string>(() => getInitialToken());

  const [from, setFrom] = useState("laptop");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatItem[]>([]);

  const hasToken = Boolean(token);

  // initialize from token (avoids setState-in-effect warnings)
  const [status, setStatus] = useState<ConnStatus>(() => (hasToken ? "connecting" : "error"));
  const [statusDetail, setStatusDetail] = useState(() =>
    hasToken ? "" : "missing_invite_token (use ?token=... or VITE_INVITE_TOKEN)"
  );

  const [transport, setTransport] = useState<string>("");

  const [roomJoin, setRoomJoin] = useState<RoomJoinState>(() => ({
    room: roomPreset,
    phase: "unknown"
  }));

  const room = roomPreset;

  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const roomRef = useRef<string>(room);

  // client-side join bookkeeping
  const joinedRoomsRef = useRef(new Set<string>());
  const joinInflightRef = useRef(new Map<string, Promise<JoinAck>>());

  // delivery bookkeeping
  const pendingIdsRef = useRef(new Set<string>());
  const pendingMapRef = useRef(new Map<string, ChatEnvelope>());
  const attemptRef = useRef(new Map<string, number>());
  const RETRY_MAX = 5;

  // dedupe
  const seenRef = useRef(new Set<string>());
  const localIdsRef = useRef(new Set<string>());

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.room === room),
    [messages, room]
  );

  const shareUrl = useMemo(() => {
    if (!token) return "";
    const u = new URL(window.location.href);
    u.searchParams.set("room", room);
    u.searchParams.set("token", token);
    return u.toString();
  }, [room, token]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const joinRoom = useCallback((r: string): Promise<JoinAck> => {
    const s = socketRef.current;

    if (!s || !s.connected) {
      return Promise.resolve({ room: r, ok: false, reason: "not_connected" });
    }

    if (joinedRoomsRef.current.has(r)) {
      return Promise.resolve({ room: r, ok: true });
    }

    const inflight = joinInflightRef.current.get(r);
    if (inflight) return inflight;

    if (roomRef.current === r) setRoomJoin({ room: r, phase: "joining" });

    const p = new Promise<JoinAck>((resolve) => {
      let settled = false;

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;

        joinInflightRef.current.delete(r);

        const res: JoinAck = { room: r, ok: false, reason: "no_ack" };
        if (roomRef.current === r) {
          setRoomJoin({ room: r, phase: "denied", reason: "no_ack" });
        }
        resolve(res);
      }, 1500);

      s.emit("join", r, (ack?: JoinAck) => {
        if (settled) return;
        settled = true;

        window.clearTimeout(timer);
        joinInflightRef.current.delete(r);

        const res: JoinAck =
          ack && typeof ack === "object" ? ack : { room: r, ok: false, reason: "bad_ack" };

        if (res.ok) {
          joinedRoomsRef.current.add(r);
          if (roomRef.current === r) setRoomJoin({ room: r, phase: "joined" });
        } else if (roomRef.current === r) {
          setRoomJoin({
            room: r,
            phase: "denied",
            reason: res.reason ?? "join_denied",
            allowedRooms: res.allowedRooms
          });
        }

        resolve(res);
      });
    });

    joinInflightRef.current.set(r, p);
    return p;
  }, []);

  const ensureJoined = useCallback(
    async (r: string): Promise<boolean> => {
      const res = await joinRoom(r);
      return Boolean(res.ok);
    },
    [joinRoom]
  );

  useEffect(() => {
    if (!hasToken) return;

    const s = io(RELAY_URL, {
      transports: ["websocket", "polling"],
      withCredentials: true,
      auth: { token }
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

    const markPendingFailed = (id: string, reason: string) => {
      pendingIdsRef.current.delete(id);
      pendingMapRef.current.delete(id);
      attemptRef.current.delete(id);

      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, delivery: "failed", error: reason } : m))
      );
    };

    const flushPending = async () => {
      const byRoom = new Map<string, ChatEnvelope[]>();

      for (const id of pendingIdsRef.current) {
        const env = pendingMapRef.current.get(id);
        if (!env) continue;
        const arr = byRoom.get(env.room) ?? [];
        arr.push(env);
        byRoom.set(env.room, arr);
      }

      for (const [r, envs] of byRoom) {
        const ok = await ensureJoined(r);

        if (!ok) {
          for (const env of envs) markPendingFailed(env.id, "join_denied");
          continue;
        }

        for (const env of envs) {
          const attempts = (attemptRef.current.get(env.id) ?? 0) + 1;
          attemptRef.current.set(env.id, attempts);

          if (attempts > RETRY_MAX) {
            markPendingFailed(env.id, "retry_limit");
            continue;
          }

          s.emit("chat", env);
        }
      }
    };

    s.on("connect", () => {
      setStatus("connected");
      setStatusDetail("");
      setFromEngine();

      // membership unknown after reconnect
      joinedRoomsRef.current.clear();
      joinInflightRef.current.clear();

      void ensureJoined(roomRef.current);
      void flushPending();
    });

    s.on("disconnect", (reason) => {
      setStatus("disconnected");
      setStatusDetail(reason ?? "");
    });

    s.on("connect_error", (err) => {
      setStatus("error");
      const msg = err?.message ?? String(err);
      setStatusDetail(msg === "unauthorized" ? "unauthorized (bad/missing token)" : msg);
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
      if (seenRef.current.has(msg.id)) return;
      seenRef.current.add(msg.id);

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
  }, [hasToken, token, ensureJoined]);

  const canSend =
    status === "connected" && roomJoin.phase === "joined" && roomJoin.room === room;

  function onRoomChange(next: RoomId) {
    setRoomPreset(next);
    roomRef.current = next;

    const s = socketRef.current;
    if (s?.connected) {
      void ensureJoined(next);
    } else {
      setRoomJoin({ room: next, phase: "unknown" });
    }
  }

  async function sendAsync() {
    const s = socketRef.current;
    if (!s) return;

    const body = text.trim();
    if (!body) return;

    // ensure join (so server doesn't deny with not_in_room)
    const ok = await ensureJoined(room);
    if (!ok) return;

    const env: ChatEnvelope = {
      id: uuid(),
      room,
      from,
      sentAt: Date.now(),
      body
    };

    localIdsRef.current.add(env.id);

    pendingIdsRef.current.add(env.id);
    pendingMapRef.current.set(env.id, env);
    attemptRef.current.set(env.id, 0);

    setMessages((prev) => [...prev, { ...env, delivery: "pending", direction: "outgoing" }]);

    s.emit("chat", env);
    setText("");
  }

  function send() {
    void sendAsync();
  }

  return (
    <div style={{ maxWidth: 780, margin: "24px auto", fontFamily: "system-ui" }}>
      <h1>N̷e̷i̷g̷h̷b̷o̷r̷h̷o̷o̷d̷ W̷a̷t̷c̷h̷</h1>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Room{" "}
          <select value={roomPreset} onChange={(e) => onRoomChange(e.target.value as RoomId)}>
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

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
        Room join:{" "}
        {roomJoin.room !== room ? (
          <span>unknown</span>
        ) : roomJoin.phase === "joined" ? (
          <span>joined</span>
        ) : roomJoin.phase === "joining" ? (
          <span>joining…</span>
        ) : roomJoin.phase === "denied" ? (
          <span>
            denied ({roomJoin.reason})
            {roomJoin.allowedRooms?.length ? (
              <span> • allowed: {roomJoin.allowedRooms.join(", ")}</span>
            ) : null}
          </span>
        ) : (
          <span>unknown</span>
        )}
      </div>

      {token ? (
        <div style={{ marginTop: 10, opacity: 0.85, fontSize: 12 }}>
          Invite link (share):
          <input style={{ width: "100%", marginTop: 6 }} readOnly value={shareUrl} />
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type a message…"
        />
        <button onClick={send} disabled={!canSend}>
          Send
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        {visibleMessages.map((m) => {
          const label = m.direction === "incoming" ? "received" : m.delivery ?? "sent";

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
