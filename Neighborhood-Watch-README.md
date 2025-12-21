# Neighborhood-Watch (Alt Connectivity v0)

A minimal real-time chat starter built to support “alternative connectivity” experiments.
This v0 provides a clean baseline: Socket.IO relay + React web client + shared protocol types.

## Repo layout

```
Neighborhood-Watch/
  apps/
    relay/          # Node + Express + Socket.IO server (message relay)
    web/            # Vite + React client
  packages/
    protocol/       # Shared TS types (events + message envelope)
  package.json      # npm workspaces (monorepo)
```

## Prereqs

- Node.js **22.12.0** (recommended; pinned via Volta)
- npm
- Git (recommended)

### Volta (toolchain pinning)

Verify:
```bash
volta -v
node -v
npm -v
```

Pin Node in this repo:
```bash
volta install node@22.12.0
volta pin node@22.12.0
```

## Install

From repo root:
```bash
npm install
npm -w packages/protocol run build
```

## Run (dev)

Terminal A (relay):
```bash
npm -w apps/relay run dev
```

Relay:
- URL: `http://127.0.0.1:8787`
- Health: `GET /health`

Verify:
```bash
curl http://127.0.0.1:8787/health
# -> {"ok":true}
```

Terminal B (web):
```bash
npm -w apps/web run dev
```

Web:
- Vite dev server (typically): `http://localhost:5173`

## Configuration

`apps/web/.env`
```env
VITE_RELAY_URL=http://127.0.0.1:8787
```

Relay allows these dev origins by default:
- `http://127.0.0.1:5173`
- `http://localhost:5173`

Override:
```bash
CLIENT_ORIGIN="http://127.0.0.1:5173,http://localhost:5173"
PORT=8787
```

## How it works

### Shared protocol (`packages/protocol`)
Defines:
- `ChatEnvelope`: `{ id, room, from, sentAt, body }`
- Socket.IO event types for client/server

### Relay (`apps/relay`)
Flow:
1) client connects
2) client emits `join(room)`
3) client emits `chat(envelope)`
4) relay broadcasts `chat(envelope)` to the room
5) relay sends `chat_ack({id, ok, reason?})` back to the sender

The relay does not store messages in v0.

### Web client (`apps/web`)
- connects to relay via Socket.IO
- joins the room
- sends typed envelopes
- renders messages
- shows connection status + current transport

## Sanity checks

- Two-tab test: open two tabs and send messages, both should receive.
- Transport: UI should show `transport: websocket` or `transport: polling`.

## Roadmap
This structure is intended to support later additions:
- ack/dedupe + retries (DTN-lite)
- persistence (IndexedDB, then optional relay storage)
- E2EE (relay becomes blind forwarder)
- alternative transports (WebRTC/BLE/Nearby)
