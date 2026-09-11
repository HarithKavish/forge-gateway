import type { Env, IngestEvent, PresenceEntry } from "./types";

/**
 * One PresenceRegistry per workspace (see index.ts -- keyed by idFromName).
 *
 * Holds presence in memory (backed by the Durable Object's own storage so it
 * survives an eviction, but never Forge's Postgres -- see the Forge repo's
 * docs/WORLDVIEW.md §4). A session goes offline either on an explicit
 * "stopped" event or when no event arrives within ONLINE_TIMEOUT_MS; the
 * alarm below is what notices the second case.
 *
 * WebSocket fan-out (build order step 4) attaches here later -- for now this
 * only answers ingest and snapshot requests, per step 2's scope.
 */

const ONLINE_TIMEOUT_MS = 90_000;

export class PresenceRegistry {
  private readonly ctx: DurableObjectState;
  private sessions = new Map<string, PresenceEntry>();
  private loaded = false;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<Record<string, PresenceEntry>>("sessions");
    if (stored) this.sessions = new Map(Object.entries(stored));
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("sessions", Object.fromEntries(this.sessions));
  }

  /** Makes sure a sweep is scheduled whenever at least one session is online. */
  private async scheduleSweep(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + ONLINE_TIMEOUT_MS);
    }
  }

  /** Marks anything that's gone quiet for too long offline. */
  async alarm(): Promise<void> {
    await this.ensureLoaded();
    const cutoff = Date.now() - ONLINE_TIMEOUT_MS;
    let changed = false;

    for (const entry of this.sessions.values()) {
      if (entry.state === "online" && entry.lastEventAt < cutoff) {
        entry.state = "offline";
        changed = true;
      }
    }
    if (changed) await this.persist();

    const stillOnline = [...this.sessions.values()].some((e) => e.state === "online");
    if (stillOnline) await this.ctx.storage.setAlarm(Date.now() + ONLINE_TIMEOUT_MS);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/events") {
      let event: IngestEvent;
      try {
        event = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!event.sessionRef) return new Response("sessionRef required", { status: 400 });

      this.sessions.set(event.sessionRef, {
        sessionRef: event.sessionRef,
        state: event.state === "stopped" ? "offline" : "online",
        activity: event.activity,
        lastEventAt: event.timestamp ?? Date.now(),
      });
      await this.persist();
      await this.scheduleSweep();
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/presence") {
      return Response.json({ sessions: [...this.sessions.values()] });
    }

    return new Response("Not found", { status: 404 });
  }
}
