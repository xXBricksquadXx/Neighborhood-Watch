export type ChatEnvelope = {
  id: string; 
  room: string; 
  from: string; 
  sentAt: number; 
  body: string; 
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
  join: (room: string, ack?: (ack: JoinAck) => void) => void;
};