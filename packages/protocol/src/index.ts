export type ChatEnvelope = {
  id: string;      // client-generated UUID
  room: string;    // e.g. "family"
  from: string;    // device/user label (v0)
  sentAt: number;  // epoch ms
  body: string;    // later: ciphertext
};

export type ChatAck = {
  id: string;
  ok: boolean;
  reason?: string;
};

export type ServerToClientEvents = {
  chat: (msg: ChatEnvelope) => void;
  chat_ack: (ack: ChatAck) => void;
};

export type ClientToServerEvents = {
  chat: (msg: ChatEnvelope) => void;
  join: (room: string) => void;
};
