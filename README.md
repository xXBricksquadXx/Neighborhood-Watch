<img width="1536" height="1024" alt="watch" src="https://github.com/user-attachments/assets/a1483d15-64b5-47db-92d2-b81081bd638c" />

# Neighborhood-Watch

A minimal real-time **private-group comms + Common Operating Picture (COP)** starter:

- Socket.IO relay
- Vite/React web client
- shared TypeScript protocol package

Designed for **low-overhead experimentation** today, with a clear path toward a modern, governance-first “BFT-inspired” workflow: **mission packages (“fills”), map overlays/routes, incident reporting, and role-based visibility**.

---

## TL;DR

- **What it is (v0):** invite-only chat rooms with allowlisted rooms + acks/dedupe/retry.
- **What it’s becoming:** a **trusted-team COP**: map + overlays + incident workspace + controlled distribution ("fills").
- **Why:** teams don’t fail from UI — they fail from inconsistent data, unclear roles, and no shared picture.

---

## Principles

- **Governance-first:** identity, enrollment, RBAC, auditability, and retention controls are primary features.
- **Transport-agnostic:** the app layer stays stable; transport becomes a replaceable module (internet now, local/degraded later).
- **Privacy by default:** location sharing is opt-in, scoped, and minimized.
- **Legit use-cases:** oriented toward **mutual aid / volunteer response / community CERT-style coordination / organizational teams**.

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

From repo `root`:

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

## Access control (v0)

v0 supports two layers:

- Invite-only connect (handshake auth)
- Allowlisted rooms (server-controlled room list)

### Invite-only connect (handshake token)

Set one or more tokens via `INVITE_TOKENS` (comma-separated).
If `INVITE_TOKENS` is set (non-empty), the relay requires a token.

PowerShell example (dev):

```powershell
$env:INVITE_TOKENS="Alpha-Team"
npm -w apps/relay run dev
```

Client provides the token either:

- via URL: `?token=Alpha-Team`
- or `apps/web/.env`: `VITE_INVITE_TOKEN=Alpha-Team`

### Allowlisted rooms

Rooms are controlled by `ALLOWED_ROOMS` (comma-separated). If not set, defaults to:
`emergency,TOC,vacant-1,vacant-2,vacant-3,vacant-4`

Example: restrict to only emergency + TOC

```powershell
$env:ALLOWED_ROOMS="emergency,TOC"
npm -w apps/relay run dev
```

Behavior:

`join(room)` returns an ack:

- ok: `true` if joined
- ok: `false` with reason and `allowedRooms` when denied

The web client surfaces this as Room join: joined / denied (`room_not_allowed`) and disables Send until joined.

---

## Configuration

### Web client env

`apps/web/.env`

```env
VITE_RELAY_URL=http://127.0.0.1:8787
# optional convenience; you can still use ?token=...
VITE_INVITE_TOKEN=Alpha-Team
```

### Relay env

Relay allows these dev origins by default:

- `http://127.0.0.1:5173`
- `http://localhost:5173`

Override:

```env
PORT=8787
CLIENT_ORIGIN="http://127.0.0.1:5173,http://localhost:5173"
INVITE_TOKENS="Alpha-Team,Backup-Token"
ALLOWED_ROOMS="emergency,TOC"
```

---

## Production build + run (local “prod mode”)

The simplest mental model: build everything once, then run the relay, and serve the web build.

1. Build (from repo root):

```bash
npm -w packages/protocol run build
npm -w apps/relay run build
npm -w apps/web run build
```

> Note: if `apps/relay` doesn’t yet have a build + start script, add them (typical pattern):
>
> - build: compile TS -> dist/
> - start: node dist/index.js

2. Run relay with env vars (PowerShell example):

```powershell
$env:PORT="8787"
$env:CLIENT_ORIGIN="https://your-domain.example"
$env:INVITE_TOKENS="Alpha-Team"
$env:ALLOWED_ROOMS="emergency,TOC"

npm -w apps/relay run start
```

If you want logs written to a file:

```powershell
npm -w apps/relay run start 2>&1 | Tee-Object -FilePath .\relay.log
```

3. Serve the web build

For Vite, the usual local production preview is:

```bash
npm -w apps/web run preview
```

Or serve `apps/web/dist/` using any static server.

---

# How it works (v0)

## Shared protocol (`packages/protocol`)

Defines:

- `ChatEnvelope`: `{ id, room, from, sentAt, body }`
- `ChatAck`: `{ id, ok, reason? }`
- `JoinAck`: `{ room, ok, reason?, allowedRooms? }`
- Socket.IO event types for client/server, including an ack callback on join

## Relay (`apps/relay`)

Flow:

1. client connects (optionally must present invite token)
2. client emits `join(room, ack)`
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

## Web client (`apps/web`)

- connects to relay via Socket.IO (auth token)
- attempts to join the active room and waits for `JoinAck`
- disables Send until the room is joined
- tracks delivery state via `chat_ack`:

  - pending → sent (ack ok)
  - pending → failed (ack reject) or retry limit reached

- retries pending messages after reconnect (bounded)
- surfaces room join denial reasons + allowed rooms list

---

# Roadmap: BFT-inspired COP direction

This repo is intentionally small, but the direction is explicit.

## Core concept: Mission Packages (“fills”)

A **Mission Package** is a versioned bundle intended to keep a team in uniformity:

- map references (online/offline)
- overlay layers (GeoJSON/KML)
- route plans (polylines + checkpoints)
- comms plan (rooms/channels + role access)
- effective window + version + provenance
- acknowledgments (“loaded”) + audit trail

Think: _distribute once, verify everyone loaded the same picture, then operate._

## Transport model: decouple app from transport

- **App layer (stable):** identity, RBAC, mission packages, COP, reporting/tasking.
- **Transport layer (replaceable):** internet relay now; local/degraded options later.

This keeps the UX and data model stable while transports evolve.

---

## Next milestones (core-first)

### Milestone 1 — Access control hardening

- multiple tokens + rotation/revocation (already supported via `INVITE_TOKENS`)
- room-scoped tokens (token grants access to a subset of rooms)
- basic audit logging: unauthorized connect attempts + denied joins

### Milestone 2 — Reliability semantics

- client: pending queue survives refresh (IndexedDB) + retries with backoff
- relay: dedupe evicts by age, not only by max size
- optional: server adds `serverReceivedAt/seq` per room for stable ordering

### Milestone 3 — COP (Map + Overlays) MVP

- Leaflet COP view
- layer manager (markers/lines/polygons)
- import/export overlays (GeoJSON)
- incident-scoped, opt-in location sharing with precision controls

### Milestone 4 — Mission Packages (“fills”) v1

- create/version/export/import mission packages
- required acknowledgments (“loaded by X”) + provenance
- role-based distribution (who can publish vs consume)

### Milestone 5 — Incident workspace

- report templates (SITREP/hazard/task)
- assignments + acknowledgments + completion states
- leader/dispatcher view (governance + accountability)

### Milestone 6 — Security posture for shareable links

- HTTPS (required for many browser APIs later)
- rate limiting + abuse protection
- tighten CORS to real domains once deployed
- retention controls + export policy

### Milestone 7 — Offline / degraded

- offline tiles (optional)
- store-and-forward sync
- conflict rules for overlay edits

### Milestone 8 — Alternative transports (later)

- WebRTC data channel fallback
- local-first sync patterns
- BLE / Wi‑Fi Direct experiments via a transport adapter interface

---

## Non-goals

- This is **not** a system proxy, MITM, or traffic interception tool.
- This is **not** a “surveillance platform.” Visibility is role-based and policy-driven.
- This is **not** a guaranteed substitute for professionally managed emergency systems.

---

## Safety, privacy, and legality

- Use this only where you have authorization and a legitimate purpose.
- Default posture should minimize sensitive data (especially location).
- Treat device compromise as normal: plan for offboarding/revocation.

---

## Status

- v0: chat rooms + invite tokens + allowlisted rooms + acks/dedupe/retry
- direction: BFT-inspired COP with mission packages, overlays, and incident workflows
