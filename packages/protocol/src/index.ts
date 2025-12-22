export type ChatEnvelope = {
  id: string; // client-generated UUID
  room: string; // e.g. "family"
  from: string; // device/user label (v0)
  sentAt: number; // epoch ms
  body: string; // later: ciphertext
};

export type ChatAck = {
  id: string;
  ok: boolean;
  reason?: string;
};

export type JoinAck = {
  room: string;
  ok: boolean;
  reason?: string;
  allowedRooms?: string[];
};

export type ServerToClientEvents = {
  chat: (msg: ChatEnvelope) => void;
  chat_ack: (ack: ChatAck) => void;
};

export type ClientToServerEvents = {
  chat: (msg: ChatEnvelope) => void;

  // Socket.IO ack callback:
  // client: socket.emit("join", room, (ack) => ...)
  // server: socket.on("join", (room, ack) => { ack?.(...) })
  join: (room: string, ack?: (ack: JoinAck) => void) => void;
};
