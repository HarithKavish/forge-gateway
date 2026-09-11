import type { Env } from "./types";

export { PresenceRegistry } from "./presence";

/**
 * Worker entry point.
 *
 * Routes each request to the PresenceRegistry Durable Object for its
 * workspace (one instance per workspace, addressed by idFromName so the
 * same workspaceId always lands on the same object). See src/presence.ts
 * for what actually happens once it gets there.
 *
 * Auth here is a single shared secret across every workspace -- a
 * deliberate placeholder for this skeleton step. The real model (per-
 * registration pairing tokens minted by Forge, short-lived per-viewer
 * tokens for the browser) lands with the registration flow and the
 * WebSocket fan-out, build order steps 3 and 4 in the Forge repo's
 * docs/WORLDVIEW.md §5 and §8 -- not implemented yet.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/events" && url.pathname !== "/presence") {
      return new Response("Not found", { status: 404 });
    }

    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.GATEWAY_SHARED_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return new Response("workspaceId is required", { status: 400 });
    }

    const id = env.PRESENCE.idFromName(workspaceId);
    const stub = env.PRESENCE.get(id);
    return stub.fetch(new Request(`https://presence${url.pathname}`, request));
  },
};
