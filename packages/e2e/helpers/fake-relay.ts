/**
 * Loopback stand-in for the DevIntern relay control plane.
 *
 * Implements only the worker long-poll contract the relay acquirer
 * (`packages/code/src/lib/relay/acquirer.ts`) consumes:
 * `GET /v1/events?cursor=<n>` with `Authorization: Bearer <relay token>`,
 * answered with `{ events: RelayEnvelope[], cursor: number }`, plus the
 * worker identity registration the worker makes at startup
 * (`POST /v1/worker/register`, and the `GET /v1/status` read that follows).
 *
 * Envelopes are published by the test with a monotonically increasing `seq`;
 * a request returns every buffered envelope whose `seq` is greater than the
 * cursor it carried, and otherwise holds the long poll until something is
 * published or {@link FakeRelayOptions.holdMs} elapses (a real relay holds up
 * to 25s; an immediate empty response would make the worker spin).
 *
 * The request log stores the cursor and whether the bearer token matched,
 * never the header value. The server binds `127.0.0.1:0` and never makes
 * outbound requests.
 */

/** Envelope shape the relay acquirer parses (mirrors `RelayEnvelope`). */
export interface FakeRelayEnvelope {
  version?: 1 | 2;
  seq: number;
  source: string;
  team?: string;
  eventType: string;
  repo?: string;
  codeHost?: FakeRelayCodeHostIdentity;
  ref: {
    task?: string;
    pr?: number;
    commentId?: number;
    change?: number;
    branch?: string;
    headSha?: string;
  };
  deliveryId: string;
  ts: string;
}

/** Code-host identity a v2 envelope carries (mirrors `RelayCodeHostIdentity`). */
export interface FakeRelayCodeHostIdentity {
  provider: string;
  instanceUrl: string;
  projectId: string;
  projectPath: string;
}

/** Input for {@link FakeRelay.publishCodeHostEvent}. */
export interface FakeRelayCodeHostEventInput {
  eventType: string;
  source: string;
  deliveryId: string;
  /** Envelope version; the acquirer only acts on code-host events at 2. */
  version?: 1 | 2;
  /** Omitted to publish an envelope without code-host identity. */
  codeHost?: FakeRelayCodeHostIdentity;
  ref: { change?: number; branch?: string; headSha?: string };
}

/** One received long poll. */
export interface FakeRelayRequest {
  /** Raw `cursor` query parameter, or null when absent. */
  cursor: string | null;
  /** Whether `Authorization` was exactly `Bearer <expected token>`. */
  authorized: boolean;
  /** HTTP status the fake answered with. */
  status: number;
  /** Number of envelopes returned. */
  delivered: number;
}

export interface FakeRelayOptions {
  /** Expected relay token. Requests without it get 401. */
  token: string;
  /** Maximum time an empty long poll is held before answering. */
  holdMs?: number;
  /**
   * Answer a new worker identity with the buffer head (what the real relay
   * does). Off by default: the identity then starts at 0, as if it had been
   * registered by `worker connect` before the test published anything.
   */
  startAtHead?: boolean;
  /** Answer `POST /v1/worker/register` with 404, like a relay without worker identities. */
  legacy?: boolean;
}

/** One received `POST /v1/worker/register`. */
export interface FakeRelayRegistration {
  authorized: boolean;
  label: string | null;
  /** `workerId` the worker sent (its persisted identity), or null for a new one. */
  workerId: string | null;
  /** Start cursor the fake answered with. */
  cursor: number;
}

/** Worker id the fake hands out. */
export const FAKE_RELAY_WORKER_ID = `wkr_${"e2".repeat(16)}`;

interface Hold {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal relay `/v1/events` long-poll server bound to `127.0.0.1`. */
export class FakeRelay {
  readonly requests: FakeRelayRequest[] = [];
  /** Requests to any route other than the ones the worker is expected to call. */
  readonly unexpectedRequests: string[] = [];
  /** Worker identity registrations received. */
  readonly registrations: FakeRelayRegistration[] = [];
  readonly url: string;

  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly token: string;
  private readonly holdMs: number;
  private readonly envelopes: FakeRelayEnvelope[] = [];
  private readonly holds = new Set<Hold>();
  private nextSeq = 1;
  private failuresRemaining = 0;
  private failureStatus = 503;
  private stopped = false;
  private readonly startAtHead: boolean;
  private readonly legacy: boolean;
  private identityCursor: number | null = null;

  constructor(options: FakeRelayOptions) {
    this.token = options.token;
    this.holdMs = options.holdMs ?? 1_000;
    this.startAtHead = options.startAtHead ?? false;
    this.legacy = options.legacy ?? false;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // Longer than any hold so Bun never cuts a held poll short.
      idleTimeout: 30,
      fetch: (request) => this.handle(request),
    });
    const port = this.server.port;
    if (port === undefined || port === 0) {
      this.server.stop(true);
      throw new Error("Fake relay did not receive a loopback port");
    }
    this.url = `http://127.0.0.1:${port}`;
  }

  /** Total long polls received, including scripted failures. */
  get requestCount(): number {
    return this.requests.length;
  }

  /** Highest `seq` published so far (0 before any). */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Buffer one `task.changed` envelope and wake held polls.
   *
   * @returns The published envelope, with its assigned `seq`
   */
  publishTaskChanged(input: {
    task: string;
    source: string;
    deliveryId: string;
    team?: string;
  }): FakeRelayEnvelope {
    const envelope: FakeRelayEnvelope = {
      version: 1,
      seq: this.nextSeq++,
      source: input.source,
      ...(input.team ? { team: input.team } : {}),
      eventType: "task.changed",
      ref: { task: input.task },
      deliveryId: input.deliveryId,
      ts: new Date().toISOString(),
    };
    this.envelopes.push(envelope);
    this.wakeHolds();
    return envelope;
  }

  /**
   * Buffer one code-host envelope (`change.feedback`, `change.changed`, …)
   * exactly as given, so a test can publish both valid v2 envelopes and the
   * malformed variants the acquirer must ignore. `version` defaults to 2.
   *
   * @returns The published envelope, with its assigned `seq`
   */
  publishCodeHostEvent(input: FakeRelayCodeHostEventInput): FakeRelayEnvelope {
    const envelope: FakeRelayEnvelope = {
      version: input.version ?? 2,
      seq: this.nextSeq++,
      source: input.source,
      eventType: input.eventType,
      ...(input.codeHost ? { codeHost: { ...input.codeHost } } : {}),
      ref: { ...input.ref },
      deliveryId: input.deliveryId,
      ts: new Date().toISOString(),
    };
    this.envelopes.push(envelope);
    this.wakeHolds();
    return envelope;
  }

  /**
   * Buffer one v2 `ci.changed` envelope for `codeHost`, with `source` set to
   * its provider (the only shape the acquirer acts on).
   *
   * @returns The published envelope, with its assigned `seq`
   */
  publishCiChanged(input: {
    codeHost: FakeRelayCodeHostIdentity;
    ref: FakeRelayCodeHostEventInput["ref"];
    deliveryId: string;
  }): FakeRelayEnvelope {
    return this.publishCodeHostEvent({
      eventType: "ci.changed",
      source: input.codeHost.provider,
      codeHost: input.codeHost,
      ref: input.ref,
      deliveryId: input.deliveryId,
    });
  }

  /** Answer the next `count` polls with `status` (default 503) instead of events. */
  failNext(count: number, status = 503): void {
    this.failuresRemaining = count;
    this.failureStatus = status;
  }

  /** Stop the server, releasing held polls first. */
  async cleanup(): Promise<void> {
    this.stop();
  }

  /** Synchronous stop for paths that cannot await. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.wakeHolds();
    this.server.stop(true);
  }

  private async handleRegister(request: Request): Promise<Response> {
    const authorized = request.headers.get("authorization") === `Bearer ${this.token}`;
    const body = (await request.json().catch(() => null)) as {
      label?: unknown;
      workerId?: unknown;
    } | null;
    const created = this.identityCursor === null;
    this.identityCursor ??= this.startAtHead ? this.lastSeq : 0;
    this.registrations.push({
      authorized,
      label: typeof body?.label === "string" ? body.label : null,
      workerId: typeof body?.workerId === "string" ? body.workerId : null,
      cursor: this.identityCursor,
    });
    if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({
      customerId: "e2e-customer",
      licenseSource: "e2e",
      worker: {
        workerId: FAKE_RELAY_WORKER_ID,
        label: body?.label,
        createdAt: 0,
        lastSeenAt: Date.now(),
      },
      created,
      // A new identity starts here; a known one is told the current head.
      cursor: created ? this.identityCursor : this.lastSeq,
      claimed: [],
      conflicts: [],
    });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/worker/register" && !this.legacy) {
      return this.handleRegister(request);
    }
    if (request.method === "GET" && url.pathname === "/v1/status" && !this.legacy) {
      return Response.json({
        customerId: "e2e-customer",
        licenseSource: "e2e",
        buffered: this.envelopes.length,
        registrations: [],
        worker: { workerId: FAKE_RELAY_WORKER_ID, label: "e2e", lastSeenAt: Date.now() },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/worker/register") {
      // A relay without worker identities: 404, which the worker tolerates.
      this.registrations.push({ authorized: false, label: null, workerId: null, cursor: 0 });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (request.method !== "GET" || url.pathname !== "/v1/events") {
      this.unexpectedRequests.push(`${request.method} ${url.pathname}`);
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const cursor = url.searchParams.get("cursor");
    const authorized = request.headers.get("authorization") === `Bearer ${this.token}`;
    const entry: FakeRelayRequest = { cursor, authorized, status: 0, delivered: 0 };
    this.requests.push(entry);

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      entry.status = this.failureStatus;
      return Response.json({ error: "scripted outage" }, { status: this.failureStatus });
    }
    if (!authorized) {
      entry.status = 401;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const after = Number(cursor ?? "0");
    if (!Number.isFinite(after) || after < 0) {
      entry.status = 400;
      return Response.json({ error: "invalid cursor" }, { status: 400 });
    }

    let events = this.pendingAfter(after);
    if (events.length === 0 && !this.stopped) {
      await this.hold(request.signal);
      events = this.pendingAfter(after);
    }
    entry.status = 200;
    entry.delivered = events.length;
    return Response.json({ events, cursor: events.at(-1)?.seq ?? after });
  }

  private pendingAfter(cursor: number): FakeRelayEnvelope[] {
    return this.envelopes.filter((envelope) => envelope.seq > cursor);
  }

  private hold(signal: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const hold: Hold = {
      resolve: () => {
        clearTimeout(hold.timer);
        this.holds.delete(hold);
        resolve();
      },
      timer: setTimeout(() => hold.resolve(), this.holdMs),
    };
    this.holds.add(hold);
    signal.addEventListener("abort", () => hold.resolve(), { once: true });
    return promise;
  }

  private wakeHolds(): void {
    // Deleting the current entry during Set iteration is well-defined.
    for (const hold of this.holds) hold.resolve();
  }
}
