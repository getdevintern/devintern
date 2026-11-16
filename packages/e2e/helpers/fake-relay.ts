/**
 * Loopback stand-in for the DevIntern relay control plane.
 *
 * Implements only the worker long-poll contract the relay acquirer
 * (`packages/code/src/lib/relay/acquirer.ts`) consumes:
 * `GET /v1/events?cursor=<n>` with `Authorization: Bearer <relay token>`,
 * answered with `{ events: RelayEnvelope[], cursor: number }`.
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
  ref: { task?: string; pr?: number; commentId?: number };
  deliveryId: string;
  ts: string;
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
}

interface Hold {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal relay `/v1/events` long-poll server bound to `127.0.0.1`. */
export class FakeRelay {
  readonly requests: FakeRelayRequest[] = [];
  /** Requests to any route other than `GET /v1/events`. */
  readonly unexpectedRequests: string[] = [];
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

  constructor(options: FakeRelayOptions) {
    this.token = options.token;
    this.holdMs = options.holdMs ?? 1_000;
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

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
