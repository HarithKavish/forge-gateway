import { normalizeClaudeEvent } from "./adapters/claude";
import { safeEqual } from "./hmac";
import { deriveSessionRef, verifyPairingToken } from "./pairing";
import type { Env, NormalizedEvent } from "./types";
import { verifyViewerToken } from "./viewer";

export { PresenceRegistry } from "./presence";

/**
 * Worker entry point.
 *
 * `POST /events/claude` is Claude Code's source adapter (docs/WORLDVIEW.md
 * §5.2 in the Forge repo) -- the endpoint a native `type: "http"` hook posts
 * to directly, no wrapper script involved. See src/pairing.ts for why the
 * pairing token itself is the ongoing bearer credential rather than a
 * one-shot exchange, and src/adapters/claude.ts for what actually gets read
 * out of Claude Code's payload.
 *
 * `GET /ws` is the WebSocket fan-out (build order step 4): the browser
 * connects directly to this Worker, not through Forge's server, carrying a
 * short-lived viewer token Forge minted from the visitor's own session
 * (lib/gateway/viewer.ts there, src/viewer.ts here). Verified here, at the
 * edge, before the upgrade is ever forwarded to a Durable Object.
 *
 * `GET /presence` is different: it's Forge's own server rendering Worldview
 * on first load, not an agent or a browser, so it stays on the plain
 * shared-secret bearer.
 *
 * `POST /events/bridge` is the Forge Local Bridge's endpoint (see the forge
 * repo's `bridge/` and docs/BRIDGE.md) -- kept entirely separate from
 * `/events/claude` rather than folded into it, because the two carry
 * genuinely different session identity: `/events/claude` derives sessionRef
 * from a hash of the pairing token itself (one token, one session, by
 * construction), which is exactly what the bridge model replaces. A single
 * bridge speaks for many real Claude sessions under one pairing token, so
 * its events carry the real `providerSessionId` explicitly instead. Both
 * endpoints keep working independently -- a machine still using the old
 * direct per-session hook config is unaffected by any of this.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/events/claude") {
      return handleClaudeEvent(request, env);
    }

    if (request.method === "POST" && url.pathname === "/events/bridge") {
      return handleBridgeEvent(request, env);
    }

    if (url.pathname === "/ws") {
      return handleWebSocket(request, env);
    }

    if (request.method === "GET" && url.pathname === "/presence") {
      return handlePresence(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleClaudeEvent(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (!token) return unauthorizedHookResponse();

  let claims;
  try {
    claims = await verifyPairingToken(env, token);
  } catch {
    return unauthorizedHookResponse();
  }

  let payload: { hook_event_name?: string; tool_name?: string };
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const event = normalizeClaudeEvent(payload);
  const sessionRef = await deriveSessionRef(token);
  const result = await recordPresence(env, claims.workspaceId, sessionRef, event);

  // Confirm with Forge once per session, not once per tool call -- everyone
  // after the first event on a given sessionRef skips this entirely. Never
  // for a revoked session -- there's nothing to confirm.
  if (result.isNew && !result.revoked) {
    await confirmWithForge(env, token).catch(() => {
      // Presence still recorded either way. A failed confirm here just
      // means Worldview's registered-sessions list won't show this one
      // until a retry succeeds; it does not affect this response, and it
      // is retried implicitly the next time this DO is evicted and this
      // sessionRef looks new again.
    });
  }

  // Always 200 with an empty object, revoked or not. Hooks read the response
  // body for permission decisions on some events -- Worldview must never be
  // the thing that blocks a tool call (docs/WORLDVIEW.md §1), so a revoked
  // session is handled by quietly no-op'ing the presence/confirm side of
  // this request, never by returning something that could be misread as a
  // block decision.
  return Response.json({});
}

interface BridgeEventPayload {
  providerSessionId?: string;
  provider?: "claude" | "codex" | "gemini" | "other";
  cwd?: string;
  state?: "working" | "idle" | "stopped";
  activity?: string;
  timestamp?: number;
}

async function handleBridgeEvent(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (!token) return unauthorizedHookResponse();

  let claims;
  try {
    claims = await verifyPairingToken(env, token);
  } catch {
    return unauthorizedHookResponse();
  }

  let payload: BridgeEventPayload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!payload.providerSessionId) {
    return new Response("providerSessionId is required", { status: 400 });
  }

  // sr_claude_<real Claude session id> -- deliberately NOT derived from the
  // token (that's the whole point: one bridge, one pairing token, many
  // sessions). See docs/BRIDGE.md "Session identity fix."
  const sessionRef = `sr_${payload.provider ?? "claude"}_${payload.providerSessionId}`;
  const event: NormalizedEvent = {
    state: payload.state ?? "working",
    activity: payload.activity,
    timestamp: payload.timestamp,
  };
  const result = await recordPresence(env, claims.workspaceId, sessionRef, event);

  if (result.isNew && !result.revoked) {
    await confirmBridgeSessionWithForge(env, token, payload.providerSessionId, payload.cwd).catch(() => {
      // Same tradeoff as confirmWithForge below: presence is still recorded
      // either way, a failed confirm just delays Worldview's registered
      // list picking this session up until the next isNew moment.
    });
  }

  return Response.json({});
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("token is required", { status: 401 });

  let claims;
  try {
    claims = await verifyViewerToken(env, token);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  // The workspace to connect to comes only from the verified token, never a
  // separately-supplied query param -- there is nothing a caller could pass
  // to see a workspace they weren't issued a token for.
  const stub = registryFor(env, claims.workspaceId);
  return stub.fetch(new Request("https://presence/ws", request));
}

async function handlePresence(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.GATEWAY_SHARED_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId) return new Response("workspaceId is required", { status: 400 });

  const stub = registryFor(env, workspaceId);
  return stub.fetch("https://presence/presence");
}

async function recordPresence(
  env: Env,
  workspaceId: string,
  sessionRef: string,
  event: NormalizedEvent,
): Promise<{ isNew: boolean; revoked: boolean }> {
  const stub = registryFor(env, workspaceId);
  const response = await stub.fetch("https://presence/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionRef, workspaceId, ...event }),
  });

  // A revoked session gets a 403 with a JSON body from the DO (src/
  // presence.ts) -- distinguishable from isNew, never left to a bare-text
  // response a caller might try to JSON-parse and crash on.
  if (response.status === 403) return { isNew: false, revoked: true };

  const { isNew } = (await response.json()) as { isNew: boolean };
  return { isNew, revoked: false };
}

async function confirmWithForge(env: Env, pairingToken: string): Promise<void> {
  const response = await fetch(`${env.FORGE_CALLBACK_URL}/api/gateway/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GATEWAY_SHARED_SECRET}`,
    },
    body: JSON.stringify({ pairingToken }),
  });
  if (!response.ok) {
    throw new Error(`Forge callback failed: ${response.status}`);
  }
}

/** Same endpoint as confirmWithForge, extended with the real session
 *  identity a bridge-driven event carries that a lone pairing token never
 *  could. Forge's route (app/api/gateway/sessions/route.ts) treats these
 *  extra fields as optional, so this is additive, not a breaking change to
 *  the old per-session flow. */
async function confirmBridgeSessionWithForge(
  env: Env,
  pairingToken: string,
  providerSessionId: string,
  cwd: string | undefined,
): Promise<void> {
  const response = await fetch(`${env.FORGE_CALLBACK_URL}/api/gateway/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GATEWAY_SHARED_SECRET}`,
    },
    body: JSON.stringify({ pairingToken, providerSessionId, cwd }),
  });
  if (!response.ok) {
    throw new Error(`Forge callback failed: ${response.status}`);
  }
}

function registryFor(env: Env, workspaceId: string): DurableObjectStub {
  return env.PRESENCE.get(env.PRESENCE.idFromName(workspaceId));
}

function unauthorizedHookResponse(): Response {
  // A hook, not a browser or a server -- still just a plain 401. The claim
  // this gateway makes no exception for a bad or expired token by silently
  // treating the session as anonymous.
  return new Response("Unauthorized", { status: 401 });
}
