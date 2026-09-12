import type { Env, ForgeStatusResponse, NormalizedEvent, PresenceEntry } from "./types";

/**
 * One PresenceRegistry per workspace (see index.ts -- keyed by idFromName).
 *
 * Holds presence in memory (backed by the Durable Object's own storage so it
 * survives an eviction, but never Forge's Postgres -- see the Forge repo's
 * docs/WORLDVIEW.md §4). A session goes offline either on an explicit
 * "stopped" event or when no event arrives within ONLINE_TIMEOUT_MS; the
 * alarm below is what notices the second case.
 *
 * The same alarm also closes the revocation gap noted in docs/WORLDVIEW.md
 * §8: this object verifies a pairing token's signature locally and never
 * asks Forge about it again per event, which means "Revoke" alone doesn't
 * stop an agent. Every REVOCATION_CHECK_INTERVAL_MS, it asks Forge whether
 * everything it's currently tracking is still `active`, and rejects further
 * events for anything that comes back `revoked` (or missing entirely). That
 * trades instant revocation for not hitting Postgres on every tool call --
 * the gap narrows to at most one interval, it doesn't close to zero.
 *
 * WebSocket fan-out (build order step 4): uses the Hibernation API
 * (`ctx.acceptWebSocket`), not a plain accept loop, so a DO with viewers
 * connected but no events flowing doesn't stay billed as active -- Cloudflare
 * can evict it between messages and wake it back up on the next one. That's
 * also why sockets are never tracked in an instance field: `ctx.getWebSockets()`
 * is the source of truth, because hibernation can construct a fresh instance
 * of this class to handle a wakeup.
 */

const ONLINE_TIMEOUT_MS = 90_000;
const REVOCATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ALARM_INTERVAL_MS = ONLINE_TIMEOUT_MS;

export class PresenceRegistry {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private sessions = new Map<string, PresenceEntry>();
  private revoked = new Set<string>();
  private workspaceId: string | undefined;
  private lastRevocationCheckAt = 0;
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const [sessions, revoked, workspaceId, lastCheck] = await Promise.all([
      this.ctx.storage.get<Record<string, PresenceEntry>>("sessions"),
      this.ctx.storage.get<string[]>("revoked"),
      this.ctx.storage.get<string>("workspaceId"),
      this.ctx.storage.get<number>("lastRevocationCheckAt"),
    ]);
    if (sessions) this.sessions = new Map(Object.entries(sessions));
    if (revoked) this.revoked = new Set(revoked);
    if (workspaceId) this.workspaceId = workspaceId;
    if (lastCheck) this.lastRevocationCheckAt = lastCheck;
    this.loaded = true;
  }

  private async persistSessions(): Promise<void> {
    await this.ctx.storage.put("sessions", Object.fromEntries(this.sessions));
  }

  private async persistRevoked(): Promise<void> {
    await this.ctx.storage.put("revoked", [...this.revoked]);
  }

  /** Makes sure the sweep/revocation alarm is scheduled whenever any session is tracked. */
  private async scheduleSweep(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private broadcast(entry: PresenceEntry): void {
    const message = JSON.stringify({ type: "update", session: entry });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // A socket that can't accept a send is on its way out; webSocketClose
        // (or the next hibernation wakeup) reconciles ctx.getWebSockets().
      }
    }
  }

  /** Marks anything that's gone quiet for too long offline, and re-checks revocation. */
  async alarm(): Promise<void> {
    await this.ensureLoaded();
    const cutoff = Date.now() - ONLINE_TIMEOUT_MS;
    let changed = false;

    for (const entry of this.sessions.values()) {
      if (entry.state === "online" && entry.lastEventAt < cutoff) {
        entry.state = "offline";
        changed = true;
        this.broadcast(entry);
      }
    }
    if (changed) await this.persistSessions();

    if (Date.now() - this.lastRevocationCheckAt >= REVOCATION_CHECK_INTERVAL_MS) {
      await this.checkRevocations();
    }

    if (this.sessions.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /** Asks Forge which currently-tracked sessions are still active. */
  private async checkRevocations(): Promise<void> {
    this.lastRevocationCheckAt = Date.now();
    await this.ctx.storage.put("lastRevocationCheckAt", this.lastRevocationCheckAt);

    if (!this.workspaceId || this.sessions.size === 0) return;

    let statuses: ForgeStatusResponse["statuses"];
    try {
      const response = await fetch(`${this.env.FORGE_CALLBACK_URL}/api/gateway/sessions/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.GATEWAY_SHARED_SECRET}`,
        },
        body: JSON.stringify({
          workspaceId: this.workspaceId,
          sessionRefs: [...this.sessions.keys()],
        }),
      });
      if (!response.ok) return;
      ({ statuses } = (await response.json()) as ForgeStatusResponse);
    } catch {
      // Forge unreachable this round -- try again at the next interval.
      // Nothing already revoked is un-revoked by a failed check either.
      return;
    }

    let revokedChanged = false;
    for (const [sessionRef, status] of Object.entries(statuses)) {
      if (status === "revoked" && !this.revoked.has(sessionRef)) {
        this.revoked.add(sessionRef);
        revokedChanged = true;
        const entry = this.sessions.get(sessionRef);
        if (entry && entry.state === "online") {
          entry.state = "offline";
          this.broadcast(entry);
        }
      }
    }
    if (revokedChanged) {
      await Promise.all([this.persistRevoked(), this.persistSessions()]);
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.acceptViewer();
    }

    if (request.method === "POST" && url.pathname === "/events") {
      let body: NormalizedEvent & { sessionRef?: string; workspaceId?: string };
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!body.sessionRef) return new Response("sessionRef required", { status: 400 });

      if (this.revoked.has(body.sessionRef)) {
        return Response.json({ revoked: true }, { status: 403 });
      }

      if (body.workspaceId && !this.workspaceId) {
        this.workspaceId = body.workspaceId;
        await this.ctx.storage.put("workspaceId", body.workspaceId);
      }

      // Whether this DO has ever seen this sessionRef before -- the signal
      // index.ts uses to decide whether it still needs to confirm the
      // registration with Forge. True on first event, and again after a
      // full DO eviction + storage reload with a genuinely new session.
      const isNew = !this.sessions.has(body.sessionRef);

      const entry: PresenceEntry = {
        sessionRef: body.sessionRef,
        state: body.state === "stopped" ? "offline" : "online",
        activity: body.activity,
        lastEventAt: body.timestamp ?? Date.now(),
      };
      this.sessions.set(body.sessionRef, entry);
      await this.persistSessions();
      await this.scheduleSweep();
      this.broadcast(entry);
      return Response.json({ isNew });
    }

    if (request.method === "GET" && url.pathname === "/presence") {
      return Response.json({ sessions: [...this.sessions.values()] });
    }

    return new Response("Not found", { status: 404 });
  }

  /** index.ts has already verified the viewer token before forwarding here. */
  private acceptViewer(): Response {
    // A WebSocketPair always has exactly these two entries; the indexed
    // access is only "possibly undefined" to noUncheckedIndexedAccess, not
    // in practice.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", sessions: [...this.sessions.values()] }));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Required by the Hibernation API even though viewers never send anything
   * meaningful -- Worldview is read-only by design (docs/WORLDVIEW.md §1).
   * Answers a bare "ping" so a client can confirm the socket is still live
   * without that counting as a real message.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    ws.close(wasClean ? code : 1011, reason);
  }
}
