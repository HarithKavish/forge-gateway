import type { Env, PairingClaims } from "./types";

/**
 * Pairing-token verification and the deterministic sessionRef derived from
 * one. Mirrors forge's lib/gateway/pairing.ts -- same HMAC-SHA256 scheme,
 * same shared secret (GATEWAY_SHARED_SECRET on both sides). Duplicated
 * rather than shared because the two repos have no common package; if the
 * scheme changes, change it in both places in the same PR pair.
 *
 * A pairing token is minted once by Forge and then used directly, and
 * repeatedly, as the bearer credential a native Claude Code HTTP hook sends
 * on every single event -- there is no separate short-lived "ingest token"
 * exchange, because a native http hook has nowhere to cache one between
 * invocations (each is a fresh process with no shared state, and the
 * request body is Claude Code's own fixed payload shape, not something this
 * gateway can ask it to carry a second credential in). The token is the
 * credential, for its whole lifetime. See the Forge repo's
 * docs/WORLDVIEW.md §7 for what that trades away: there is no way to revoke
 * a single leaked token early short of rotating GATEWAY_SHARED_SECRET,
 * which invalidates every token everywhere. Forge's own session cookies
 * already accept the identical tradeoff (docs/AUTH.md "Sessions").
 */

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return atob(padded);
}

/** Equal-length comparison that doesn't short-circuit on the first mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPairingToken(env: Env, token: string): Promise<PairingClaims> {
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("Malformed pairing token");

  const expected = await hmac(env.GATEWAY_SHARED_SECRET, body);
  if (!safeEqual(signature, expected)) throw new Error("Invalid pairing token signature");

  const claims = JSON.parse(fromBase64Url(body)) as PairingClaims;
  if (claims.exp < Date.now()) throw new Error("Pairing token has expired");
  return claims;
}

/**
 * The same token always derives the same sessionRef, computed independently
 * by Forge and by this gateway from the identical raw token string -- no
 * exchange or lookup needed to agree on it. `sr_` + the first 32 hex
 * characters of SHA-256(token), which is plenty to be collision-free for
 * this many concurrent sessions without needing the full 64.
 */
export async function deriveSessionRef(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sr_${hex.slice(0, 32)}`;
}
