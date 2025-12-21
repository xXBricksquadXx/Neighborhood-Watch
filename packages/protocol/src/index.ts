export type ChatEnvelope = {
  id: string;            // client-generated UUID
  room: string;          // e.g. "family"
  from: string;          // device/user label for now
  sentAt: number;        // epoch ms
  body: string;          // later: ciphertext
};

export type ServerToClientEvents = {
  chat: (msg: ChatEnvelope) => void;
};

export type ClientToServerEvents = {
  chat: (msg: ChatEnvelope) => void;
  join: (room: string) => void;
};
