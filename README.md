<img width="1536" height="1024" alt="watch" src="https://github.com/user-attachments/assets/a1483d15-64b5-47db-92d2-b81081bd638c" />
---

A minimal real-time “private group comms” starter focused on **low-overhead experimentation**:
a Socket.IO relay + a Vite/React client + shared TypeScript protocol types.

This repo is intentionally small so you can iterate toward:

- invite-only group access (share a link with selected people)
- allowlisted rooms (server-controlled room list)
- predictable delivery semantics (ack/dedupe/retry)
- eventual end-to-end encryption (relay becomes a blind forwarder)
- alternative transports later (WebRTC/BLE/mesh), without rewriting the core UX

---

## Repo layout

```
Neighborhood-Watch/
apps/
relay/ # Node + Express + Socket.IO server (message relay)
web/ # Vite + React client
packages/
protocol/ # Shared TS types (events + message envelope/acks)
package.json # npm workspaces (monorepo)
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

```
volta install node@22.12.0
volta pin node@22.12.0

```

---

**Install**
From repo `root`:

```
npm install
npm -w packages/protocol run build

```

---

Run (dev)
Terminal A (relay)

```
npm -w apps/relay run dev

```

Relay:

- URL: `http://127.0.0.1:8787`
- Health: `GET /health`

Verify:

```
curl http://127.0.0.1:8787/health
# {"ok":true}

```

Terminal B (web)

```
npm -w apps/web run dev

```

Web (Vite dev server):

- Typically `http://localhost:5173`

---

**Access control (v0)**

v0 supports two layers:

- Invite-only connect (handshake auth)
- Allowlisted rooms (server-side allowed room set)

**Invite-only connect (handshake token)**

Set one or more tokens via `INVITE_TOKENS` (comma-separated).
If `INVITE_TOKENS` is set (non-empty), the relay requires a token.

PowerShell example (dev):

```
$env:INVITE_TOKENS="Crows-Nest"
npm -w apps/relay run dev

```

Client provides the token either:

- via URL: `?token=Crows-Nest`
- or `apps/web/.env`: `VITE_INVITE_TOKEN=Crows-Nest`

Allowlisted rooms

Rooms are controlled by `ALLOWED_ROOMS` (comma-separated). If not set, defaults to:
`emergency,family,vacant-1,vacant-2,vacant-3,vacant-4`

Example: restrict to only emergency + family

```
$env:ALLOWED_ROOMS="emergency,family"
npm -w apps/relay run dev

```

Behavior:

`join(room)` returns an ack:

- ok: `true` if joined
- ok: `false` with reason and `allowedRooms` when denied

## The web client surfaces this as Room join: joined / denied (room_not_allowed) and disables Send until joined.

**Configuration**

Web client env

`apps/web/.env`

```env
VITE_RELAY_URL=http://127.0.0.1:8787
# optional convenience; you can still use ?token=...
VITE_INVITE_TOKEN=Crows-Nest

```

Relay env

Relay allows these dev origins by default:

- `http://127.0.0.1:5173`
- `http://localhost:5173`

Override:

```
PORT=8787
CLIENT_ORIGIN="http://127.0.0.1:5173,http://localhost:5173"
INVITE_TOKENS="Crows-Nest,Backup-Token"
ALLOWED_ROOMS="emergency,family"

```

---

Production build + run (local “prod mode”)

The simplest mental model: build everything once, then run the relay, and serve the web build.

1. Build

From repo root:

```
npm -w packages/protocol run build
npm -w apps/relay run build
npm -w apps/web run build

```

> Note: if apps/relay doesn’t yet have a build + start script, add them (typical pattern):
>
> - build: compile TS -> dist/
> - start: node dist/index.js

2. Run relay with env vars

PowerShell example (prod run):

```
$env:PORT="8787"
$env:CLIENT_ORIGIN="https://your-domain.example"
$env:INVITE_TOKENS="Crows-Nest"
$env:ALLOWED_ROOMS="emergency,family"

npm -w apps/relay run start

```

If you want logs written to a file:

```
npm -w apps/relay run start 2>&1 | Tee-Object -FilePath .\relay.log

```

3. Serve the web build

For Vite, the usual local production preview is:

```
npm -w apps/web run preview

```

Or serve `apps/web/dist/` using any static server.

---

# How it works

Shared protocol (`packages/protocol`)

Defines:

- ChatEnvelope: { `id, room, from, sentAt, body `}
- ChatAck: { `id, ok, reason?` }
- JoinAck: { `room, ok, reason?, allowedRooms?` }
- Socket.IO event types for client/server, including an ack callback on join

**Relay (apps/relay)**

Flow:

1. client connects (optionally must present invite token)

2. client emits join(room, ack)

3. relay validates + allowlists the room

4. relay either:

- `socket.join(room)` and acks ok
- or acks denied with `reason + allowedRooms`

5. client emits `chat(envelope)`

6. relay validates envelope (length/type checks)

7. relay enforces membership: sender must have joined `envelope.room`

8. relay dedupes by `envelope.id` (in-memory)

9. relay broadcasts `chat(envelope)` to the room

10. relay sends `chat_ack({id, ok, reason?})` to the sender

Notes:

- v0 does not persist messages on the server
- dedupe is best-effort and resets on relay restart

Web client (`apps/web`)

- connects to relay via Socket.IO (auth token)
- attempts to join the active room and waits for JoinAck
- disables Send until the room is joined
- tracks delivery state via chat_ack:
- pending → sent (ack ok)
- pending → failed (ack reject) or retry limit reached
- retries pending messages after reconnect (bounded)
- surfaces room join denial reasons + allowed rooms list

---

## Next milestones (core-first)

**Milestone 1** — `Access control hardening`

- multiple tokens + rotation/revocation (already supported via INVITE_TOKENS)
- room-scoped tokens (token grants access to a subset of rooms)
- basic audit logging: unauthorized connect attempts + denied joins
- DoD: you can invalidate one leaked link without breaking everyone else

**Milestone 2** — `Reliability semantics`

- client: pending queue survives refresh (IndexedDB) + retries with backoff
- relay: dedupe evicts by age, not only by max size
- optional: server adds serverReceivedAt/seq per room for stable ordering
- DoD: kill relay, restart, clients reconnect, pending messages resend or fail deterministically

**Milestone 3** — `Persistence (optional)`

- start client-only (IndexedDB) so it’s free and simple
- later: relay persistence (SQLite) if you need multi-device history
- DoD: reload page, history is still there

**Milestone 4** — `Security posture for “shareable link”`

- HTTPS (required for many browser APIs later)
- rate limiting + abuse protection
- tighten CORS to real domains once deployed
- DoD: you can deploy and share a link without “open relay” risk

**Milestone 5** — `Alternative transports (later)`

- WebRTC datachannel fallback
- local-first / store-and-forward strategies
