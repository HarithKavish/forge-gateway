# Forge Gateway

The presence gateway for [Forge](https://github.com/HarithKavish/forge)'s
Worldview page — a live map of coding-agent sessions (Claude Code, Codex, …)
across projects and people. This service receives hook events from those
agents, tracks which sessions are online, and answers Forge's Worldview page
with that presence. It never stores what an agent said or did — see
[Data model](#data-model) below.

Design source of truth: `docs/WORLDVIEW.md` in the Forge repo. This repo
implements build-order steps 2 through 4 from that document — the presence
registry, a real Claude Code source adapter, and live WebSocket fan-out to
the browser.

## Where it lives

Deployed on Cloudflare Workers. No live URL yet — first deploy is still
pending (`wrangler deploy`).

## How to run it

Requires Node 20+ and a Cloudflare account.

```bash
npm install
wrangler secret put GATEWAY_SHARED_SECRET   # any strong random value
npm run dev
```

`GATEWAY_SHARED_SECRET` must be **identical** to Forge's own
`GATEWAY_SHARED_SECRET` — it signs and verifies pairing tokens on both sides,
and authenticates this Worker's callback to Forge. `FORGE_CALLBACK_URL`
(`wrangler.toml`, a plain var — defaults to `http://localhost:3000`) needs to
point at wherever Forge actually runs.

Deploy with `npm run deploy`. Typecheck with `npm run typecheck`.

## Connecting a real Claude Code session

There is no wrapper script. Claude Code's native `type: "http"` hooks POST
directly to this gateway; a pairing token from Forge's `/worldview` page
("Connect a real agent") is the only credential needed.

1. On Forge's `/worldview` page, mint a pairing token. Forge shows the exact
   `export WORLDVIEW_PAIRING_TOKEN=...` line and `.claude/settings.json`
   block to paste — copy both.
2. Set the env var wherever `claude` runs, and add the hook config. It wires
   `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd` to
   `POST {gatewayUrl}/events/claude`, with
   `Authorization: Bearer $WORLDVIEW_PAIRING_TOKEN` via `allowedEnvVars`.
3. Start a Claude Code session. The first event registers the session in
   Forge (one callback, not one per tool call — see [How registration
   works](#how-registration-works)); every session shows as `Registered` on
   `/worldview` from then on.

The pairing token is used directly, and repeatedly, as the bearer credential
for the whole life of that hook config — there's no separate short-lived
token exchanged after the first use, because a native `http` hook has
nowhere to cache one between invocations (each firing is a fresh, stateless
request). It's valid for 90 days.

Revoking a session in Forge (`/worldview` → Revoke) does take effect here,
but not instantly: this gateway verifies a pairing token's signature
locally and never re-checks Forge on every event, so it re-checks
periodically instead (`POST /api/gateway/sessions/status`, every 5 minutes
— see `src/presence.ts`). A revoked token is rejected within one interval
of being revoked, not immediately. Rotating `GATEWAY_SHARED_SECRET` remains
the only way to invalidate a token instantly, at the cost of invalidating
every pairing *and* viewer token everywhere at once.

## How registration works

`sessionRef` is derived deterministically from the pairing token itself —
`sr_` + the first 32 hex characters of `SHA-256(token)` — computed
independently by Forge and by this gateway from the identical raw token
string (`src/pairing.ts` here, `lib/gateway/pairing.ts` in Forge). Neither
side has to tell the other what it is.

That means presence recording never waits on Forge: every event verifies the
token locally (this gateway holds the same signing secret) and writes to the
workspace's `PresenceRegistry` immediately. Only the *first* event for a
given `sessionRef` also triggers a callback to
`POST {FORGE_CALLBACK_URL}/api/gateway/sessions`, which is what actually
creates the `agent_sessions` row — everything after that is presence-only,
so a session mid-conversation isn't hitting Forge's Postgres on every tool
call. If that first callback fails (Forge unreachable, say), presence still
gets recorded; the callback is simply retried the next time this gateway
considers the session new again (e.g. after a Durable Object eviction).

## API

- `POST /events/claude` — Claude Code's source adapter (`src/adapters/claude.ts`).
  Body is Claude Code's own native hook payload, sent as-is by a `type:
  "http"` hook — this endpoint reads only `hook_event_name` and `tool_name`
  out of it, nothing else (see [Data model](#data-model)).
  `Authorization: Bearer <pairing token>`. Returns `{}` — hooks read the
  response for permission decisions on some events, and an empty object
  means no opinion, never a block.
- `GET /presence?workspaceId=<id>` — returns `{ sessions: PresenceEntry[] }`
  for the workspace. This is Forge's own server rendering Worldview on first
  load, not an agent or a browser, so it stays on the plain `Authorization:
  Bearer <GATEWAY_SHARED_SECRET>`.
- `GET /ws?token=<viewer token>` — WebSocket upgrade. The browser connects
  here directly (not through Forge's server), carrying a short-lived viewer
  token Forge mints from the visitor's own session
  (`lib/gateway/viewer.ts` in Forge, `src/viewer.ts` here — 10-minute TTL,
  reissued on every reconnect). The token's `workspaceId` claim is the only
  thing that decides which workspace's `PresenceRegistry` the socket
  attaches to; there's no separate parameter a caller could mismatch it
  with. On connect, the server sends one `{"type":"snapshot","sessions":
  [...]}"` message with everything currently known, then a
  `{"type":"update","session":{...}}` message every time any session's
  presence changes. Read-only: nothing sent from the browser does anything,
  other than a literal `"ping"` answered with `"pong"` as a liveness check.
  Built on Durable Objects' Hibernation API, so a socket sitting idle
  between events doesn't keep its `PresenceRegistry` billed as active.

A future provider (Codex, Gemini, …) gets its own `/events/<provider>` route
and its own file under `src/adapters/`, each reading whatever that
provider's native hook/callback shape actually is — this Worker and the
`PresenceRegistry` Durable Object don't change.

## Data model

Presence — online/offline state, the current activity label, last-event
timestamp — lives only in the `PresenceRegistry` Durable Object for each
workspace. It is never written to Forge's Postgres, and a session that's
gone offline for good has no history to look back at. That split is
deliberate and load-bearing, not a v1 shortcut — see `docs/WORLDVIEW.md` §4
in the Forge repo for why.

The activity label is deliberately thin: a tool's *name* ("Bash", "Edit"),
never its arguments, output, or anything Claude said. `src/adapters/claude.ts`
reads exactly two fields off Claude Code's native payload
(`hook_event_name`, `tool_name`) and nothing else — verified locally by
running the adapter against real payloads, including one carrying a
deliberately sensitive `tool_input.command` and `last_assistant_message`,
and confirming neither ever reaches `/presence`.

## Verified locally

Both the Claude Code adapter and the WebSocket fan-out were exercised
against a real local `wrangler dev`, not just read for correctness:
auth rejection (missing/garbage/expired pairing and viewer tokens),
the full `SessionStart` → `PreToolUse` → `PostToolUse` → `Stop` →
`SessionEnd` state progression reflected correctly in `/presence`, a
deliberately sensitive `tool_input.command` and `last_assistant_message`
confirmed to never surface anywhere, Forge's Node.js `deriveSessionRef`
and this repo's WebCrypto implementation confirmed to produce
byte-identical output for the same token, and a live WebSocket client
confirmed to receive the initial snapshot and then a real-time `update`
message the instant a triggered event landed.

The periodic revocation check was exercised the same way, against a mock
Forge server: a session confirmed online, then flipped to `revoked` by the
mock, correctly went `offline` on the next check cycle (well before its
online-timeout would have expired it anyway, to rule out a false pass), and
a further event with that same token came back a clean `200 {}` rather than
resurrecting its presence. That run also caught a real bug -- the Worker
was unconditionally parsing the Durable Object's response as JSON, which
crashed with a 500 the first time that response was a plain-text 403
instead -- fixed before this was committed, not after.

## Ecosystem membership

Part of the HarithKavish ecosystem. See [AGENTS.md](AGENTS.md) and
[GOVERNANCE.md](GOVERNANCE.md).
