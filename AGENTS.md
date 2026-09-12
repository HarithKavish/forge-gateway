# Agent Instructions

This repository is part of the **HarithKavish ecosystem**.

**Before changing anything**, read
[AGENT_BOOTSTRAP.md](https://github.com/HarithKavish/harithkavish-governance/blob/main/AGENT_BOOTSTRAP.md)
and follow it. See [GOVERNANCE.md](GOVERNANCE.md) for what governs this repository.

Do not begin implementation work before discovery is complete.

## Hard stops

A reminder, not the rule. These restate doctrine articles so an agent that reads nothing
else still has the guardrails. Governance is authoritative; if these ever disagree with
it, governance wins.

- Do not commit to the production branch (Article 6).
- Do not commit secrets or credentials (Article 5, SECURITY).
- Do not redefine design foundations locally (Article 4).
- Do not copy governance or the design system into this repository (Article 3).
- Do not act outside the scope you were given (Article 9).

## About this repository

The presence gateway for Forge's Worldview page: a Cloudflare Worker plus a
per-workspace Durable Object that receives coding-agent hook events, tracks
which sessions are online, and answers Forge with that presence. See
`README.md` for the API and `PresenceRegistry` in `src/presence.ts` for the
actual logic.

## Working here

- The design this repo implements lives in `docs/WORLDVIEW.md` in the
  [Forge repo](https://github.com/HarithKavish/forge), not here. Read that
  before changing the presence model, the auth model, or the data split
  between this repo and Forge's Postgres — deviating from it needs the same
  reasoning that document already went through, not a fresh guess.
- Presence data (online state, activity labels) must never be written to
  Forge's Postgres, and must never persist here longer than a session stays
  relevant. This is a hard constraint from `docs/WORLDVIEW.md` §4, not a
  style preference.
- Agents never see `GATEWAY_SHARED_SECRET`. A Claude Code hook holds a
  pairing token instead (`src/pairing.ts`) — verified locally against the
  same secret, but not the secret itself. Don't "simplify" auth by handing
  the shared secret to a hook config; that's the credential-leak trap this
  design specifically avoids.
- Adding a new provider (Codex, Gemini, …) means a new `src/adapters/*.ts`
  and a new `/events/<provider>` route in `src/index.ts` — not a change to
  `PresenceRegistry` or the pairing/session model. See `src/adapters/claude.ts`
  for the shape one takes, and read only whatever fields are actually a
  category label (a tool name, an event name) — never a provider's raw
  payload wholesale.
