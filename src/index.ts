import { normalizeClaudeEvent } from "./adapters/claude";
import { deriveSessionRef, verifyPairingToken } from "./pairing";
import type { Env, NormalizedEvent } from "./types";

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
 * `GET /presence` is different: it's Forge's own server rendering Worldview,
 * not an agent, so it stays on the plain shared-secret bearer.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/events/claude") {
      return handleClaudeEvent(request, env);
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
  const isNew = await recordPresence(env, claims.workspaceId, sessionRef, event);

  // Confirm with Forge once per session, not once per tool call -- everyone
  // after the first event on a given sessionRef skips this entirely.
  if (isNew) {
    await confirmWithForge(env, token).catch(() => {
      // Presence still recorded either way. A failed confirm here just
      // means Worldview's registered-sessions list won't show this one
      // until a retry succeeds; it does not affect this response, and it
      // is retried implicitly the next time this DO is evicted and this
      // sessionRef looks new again.
    });
  }

  // Hooks read the response body for permission decisions on some events.
  // An empty object means no opinion -- never block a tool call from here.
  return Response.json({});
}

async function handlePresence(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.GATEWAY_SHARED_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId) return new Response("workspaceId is required", { status: 400 });

  const stub = registryFor(env, workspaceId);
  return stub.fetch("https://presence/presence");
}

/** Returns whether this was the first event this gateway has seen for the session. */
async function recordPresence(
  env: Env,
  workspaceId: string,
  sessionRef: string,
  event: NormalizedEvent,
): Promise<boolean> {
  const stub = registryFor(env, workspaceId);
  const response = await stub.fetch("https://presence/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionRef, ...event }),
  });
  const { isNew } = (await response.json()) as { isNew: boolean };
  return isNew;
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

function registryFor(env: Env, workspaceId: string): DurableObjectStub {
  return env.PRESENCE.get(env.PRESENCE.idFromName(workspaceId));
}

function unauthorizedHookResponse(): Response {
  // A hook, not a browser or a server -- still just a plain 401. The claim
  // this gateway makes no exception for a bad or expired token by silently
  // treating the session as anonymous.
  return new Response("Unauthorized", { status: 401 });
}
