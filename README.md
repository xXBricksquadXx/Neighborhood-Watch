# Neighborhood-Watch (Alt Connectivity v0)

A minimal real-time “private group comms” starter focused on **low-overhead experimentation**:
a Socket.IO relay + a Vite/React client + shared TypeScript protocol types.

This repo is intentionally small so you can iterate toward:
- invite-only group access (share a link with selected people)
- resilient delivery patterns (ack/dedupe/retry)
- eventual end-to-end encryption (relay becomes a blind forwarder)
- alternative transports later (WebRTC/BLE/mesh), without rewriting the core UX

---

## Repo layout

```
Neighborhood-Watch/
  apps/
    relay/          # Node + Express + Socket.IO server (message relay)
    web/            # Vite + React client
  packages/
    protocol/       # Shared TS types (events + message envelope/ack)
  package.json      # npm workspaces (monorepo)
```

---

## Prereqs

- Node.js **22.12.0** (recommended; pinned via Volta)
- npm
- Git (recommended)

### Volta toolchain pinning

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

---

## Install

From repo root:

```bash
npm install
npm -w packages/protocol run build
```

---

## Run (dev)

### Terminal A (relay)

```bash
npm -w apps/relay run dev
```

Relay:
- URL: `http://127.0.0.1:8787`
- Health: `GET /health`

Verify:
```bash
curl http://127.0.0.1:8787/health
# {"ok":true}
```

### Terminal B (web)

```bash
npm -w apps/web run dev
```

Web (Vite dev server):
- Typically `http://localhost:5173`

---

## Configuration

### Web client env

`apps/web/.env`
```env
VITE_RELAY_URL=http://127.0.0.1:8787
```

### Relay env

Relay allows these dev origins by default:
- `http://127.0.0.1:5173`
- `http://localhost:5173`

Override:
```bash
PORT=8787
CLIENT_ORIGIN="http://127.0.0.1:5173,http://localhost:5173"
```

---

## How it works

### Shared protocol (`packages/protocol`)

Defines:
- `ChatEnvelope`: `{ id, room, from, sentAt, body }`
- `ChatAck`: `{ id, ok, reason? }`
- Socket.IO event types for client/server

### Relay (`apps/relay`)

Flow:
1) client connects
2) client emits `join(room)`
3) client emits `chat(envelope)`
4) relay validates `envelope` (length/type checks)
5) relay **enforces membership**: sender must have joined `envelope.room`
6) relay **dedupes** by `envelope.id` (in-memory)
7) relay broadcasts `chat(envelope)` to the room
8) relay sends `chat_ack({id, ok, reason?})` back to the sender

Notes:
- v0 does **not** persist messages on the server
- dedupe is best-effort and resets on relay restart

### Web client (`apps/web`)

- connects to relay via Socket.IO
- joins the active room (preset dropdown)
- sends typed envelopes
- tracks delivery state via `chat_ack`:
  - `pending` → `sent` (ack ok)
  - `pending` → `failed` (ack reject) or retry limit reached
- retries pending messages after reconnect (bounded)
- labels messages as:
  - `received` (incoming)
  - `pending/sent/failed` (outgoing)

---

## Sanity checks

### Two-instance test (recommended)
- Open **two tabs**:
  - Tab A: room `Emergency`, from `laptop`
  - Tab B: room `Emergency`, from `phone`
- Send messages from each; both should see them.
- Switch Tab B to a different room; messages should **not** bleed across rooms.

Tip: easiest isolation is one normal window + one private/incognito window.

### Resilience test: kill relay
- Send a message while relay is down (it stays `pending`)
- Restart relay
- Client reconnects and replays pending messages (up to retry limit)

---

## Troubleshooting

### “Cannot access refs during render” (React)
Avoid reading `ref.current` inside render/JSX. Stamp needed values into state when events occur.

### CORS / connection issues
- Use `VITE_RELAY_URL=http://127.0.0.1:8787`
- Ensure relay allows both `localhost` and `127.0.0.1` origins (default behavior).

### npm workspace installs
Prefer one of these (from repo root):
```bash
npm install zod -w apps/relay
# or
npm -w apps/relay install zod
```

If you `cd apps/relay`, do **not** use `-w`:
```bash
cd apps/relay
npm install zod
```

---

## Roadmap (next milestones)

**Invite-only access**
- share an invite link or token with selected people
- relay rejects unknown/expired tokens

**E2EE (relay-blind)**
- encrypt message bodies client-side
- relay forwards ciphertext only

**Persistence**
- store message history client-side (IndexedDB)
- optional server persistence later

**Alternative transports**
- add WebRTC for peer-to-peer within a LAN
- later: BLE/mesh experiments feeding the same message model

---
