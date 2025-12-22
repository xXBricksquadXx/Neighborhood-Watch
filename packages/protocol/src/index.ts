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

/**
 * Ack for join(room).
 * When ok=false, relay may include allowedRooms to help client recover.
 */
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

  /**
   * Join a room; relay responds via ack callback.
   * Socket.IO supports ack callbacks as the last argument.
   */
  join: (room: string, ack?: (res: JoinAck) => void) => void;
};
