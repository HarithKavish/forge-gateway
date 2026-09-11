export interface Env {
  PRESENCE: DurableObjectNamespace;
  GATEWAY_SHARED_SECRET: string;
  FORGE_CALLBACK_URL: string;
}

/** Claims embedded in a Forge-minted pairing token. See src/pairing.ts. */
export interface PairingClaims {
  workspaceId: string;
  ownerId: string;
  provider: "claude" | "codex" | "gemini" | "other";
  projectId: string | null;
  label: string | null;
  exp: number;
}

/**
 * Claims embedded in a Forge-minted viewer token. See src/viewer.ts. Unlike
 * a pairing token, this gateway only ever verifies one -- Forge is the only
 * party that mints them, since a viewer token is issued from a Forge
 * session, and this gateway has no notion of a Forge session of its own.
 */
export interface ViewerClaims {
  workspaceId: string;
  userId: string;
  exp: number;
}

/**
 * What a source adapter (src/adapters/*) normalizes a provider's native hook
 * payload down to, and what actually reaches the PresenceRegistry Durable
 * Object. Content-free by construction: state and a short activity label,
 * never a prompt, a diff, tool input, or tool output.
 */
export interface NormalizedEvent {
  /** "stopped" is the only state that forces offline; anything else is online. */
  state: "working" | "idle" | "stopped";
  activity?: string;
  timestamp?: number;
}

export type PresenceState = "online" | "offline";

/** What lives in a workspace's PresenceRegistry. Never written to Forge's Postgres. */
export interface PresenceEntry {
  sessionRef: string;
  state: PresenceState;
  activity?: string;
  lastEventAt: number;
}
