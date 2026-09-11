export interface Env {
  PRESENCE: DurableObjectNamespace;
  GATEWAY_SHARED_SECRET: string;
}

/** What a hook/source adapter posts to /events. Content-free by design. */
export interface IngestEvent {
  sessionRef: string;
  /** "stopped" is the only state that forces offline; anything else is online. */
  state: "working" | "idle" | "stopped";
  /** A short label, e.g. "running tests". Never provider content. */
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
