import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatEnvelope, ClientToServerEvents, ServerToClientEvents } from "@ac/protocol";

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "http://127.0.0.1:8787";

function uuid(): string {
  return crypto.randomUUID();
}

type ConnStatus = "connecting" | "connected" | "disconnected" | "error";

export default function App() {
  const [room, setRoom] = useState("family");
  const [from, setFrom] = useState("laptop");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatEnvelope[]>([]);

  // Start in "connecting" so we don't need setState in the effect body (ESLint rule)
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState("");

  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const roomRef = useRef(room);

  // Keep latest room for the connect handler
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

    s.on("connect", () => {
      setStatus("connected");
      setStatusDetail("");
      s.emit("join", roomRef.current);
    });

    s.on("disconnect", (reason) => {
      setStatus("disconnected");
      setStatusDetail(reason ?? "");
    });

    s.on("connect_error", (err) => {
      setStatus("error");
      setStatusDetail(err?.message ?? String(err));
    });

    s.on("chat", (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  function send() {
    const s = socketRef.current;
    if (!s) return;

    const body = text.trim();
    if (!body) return;

    const msg: ChatEnvelope = {
      id: uuid(),
      room,
      from,
      sentAt: Date.now(),
      body
    };

    s.emit("chat", msg);
    setText("");
  }

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", fontFamily: "system-ui" }}>
      <h1>Alt Connectivity v0</h1>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Room{" "}
          <input value={room} onChange={(e) => setRoom(e.target.value)} />
        </label>

        <label>
          From{" "}
          <input value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <div>
          Status: <b>{status}</b>
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
            </div>
            <div>{m.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
