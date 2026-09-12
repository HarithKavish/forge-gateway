import { fromBase64Url, hmac, safeEqual } from "./hmac";
import type { Env, ViewerClaims } from "./types";

/**
 * Viewer-token verification.
 *
 * Short-lived (10 minutes, minted by Forge in lib/gateway/viewer.ts) and
 * reissued by the browser on every reconnect -- unlike a pairing token, a
 * viewer token only ever needs to survive one page view's worth of a
 * WebSocket connection, so there's no long-lived-credential tradeoff to
 * accept here the way there is for pairing tokens (docs/WORLDVIEW.md §7,
 * §8 in the Forge repo). Scopes the connection to exactly the workspace
 * the token was minted for -- see src/index.ts's /ws handler.
 */
export async function verifyViewerToken(env: Env, token: string): Promise<ViewerClaims> {
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("Malformed viewer token");

  const expected = await hmac(env.GATEWAY_SHARED_SECRET, body);
  if (!safeEqual(signature, expected)) throw new Error("Invalid viewer token signature");

  const claims = JSON.parse(fromBase64Url(body)) as ViewerClaims;
  if (claims.exp < Date.now()) throw new Error("Viewer token has expired");
  return claims;
}
