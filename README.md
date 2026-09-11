# Forge Gateway

The presence gateway for [Forge](https://github.com/HarithKavish/forge)'s
Worldview page — a live map of coding-agent sessions (Claude Code, Codex, …)
across projects and people. This service receives hook events from those
agents, tracks which sessions are online, and answers Forge's Worldview page
with that presence. It never stores what an agent said or did — see
[Data model](#data-model) below.

Design source of truth: `docs/WORLDVIEW.md` in the Forge repo. This repo
implements build-order step 2 from that document — the gateway skeleton
(ingest + in-memory presence + snapshot REST, no WebSocket yet).

## Where it lives

Deployed on Cloudflare Workers. No live URL yet — first deploy is still
pending (`wrangler deploy`).

## How to run it

Requires Node 20+ and a Cloudflare account.

```bash
npm install
wrangler secret put GATEWAY_SHARED_SECRET   # any strong random value, for local dev too
npm run dev
```

`GATEWAY_SHARED_SECRET` gates every request for now — a placeholder for this
skeleton step. The real model (per-registration pairing tokens, short-lived
per-viewer tokens) lands with the registration flow and WebSocket fan-out;
see `src/index.ts` for exactly where that's marked.

Deploy with `npm run deploy`. Typecheck with `npm run typecheck`.

## API (current)

Both endpoints take `workspaceId` as a query parameter and require
`Authorization: Bearer <GATEWAY_SHARED_SECRET>`.

- `POST /events` — body `{ sessionRef, state, activity?, timestamp? }`.
  `state` is `"working"`, `"idle"`, or `"stopped"`; anything but `"stopped"`
  marks the session online. Returns `204`.
- `GET /presence` — returns `{ sessions: PresenceEntry[] }` for the workspace.

There is no registration endpoint yet — `sessionRef` values are expected to
already exist as `agent_sessions` rows in Forge (registered manually today,
via `/worldview`).

## Data model

Presence — online/offline state, the current activity label, last-event
timestamp — lives only in the `PresenceRegistry` Durable Object for each
workspace. It is never written to Forge's Postgres, and a session that's
gone offline for good has no history to look back at. That split is
deliberate and load-bearing, not a v1 shortcut — see `docs/WORLDVIEW.md` §4
in the Forge repo for why.

## Ecosystem membership

Part of the HarithKavish ecosystem. See [AGENTS.md](AGENTS.md) and
[GOVERNANCE.md](GOVERNANCE.md).
