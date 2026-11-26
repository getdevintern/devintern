/**
 * Loopback stand-in for notification endpoints (Slack incoming webhooks and
 * the generic JSON webhook).
 *
 * Records the method, path, headers, and exact raw body of every request so
 * tests can recompute an HMAC signature over the bytes the worker sent. Each
 * path can answer with its own status, so one channel can fail while another
 * stays healthy on the same server.
 */

/** One request a notification channel made to the fake receiver. */
export interface NotificationRequestRecord {
  method: string;
  path: string;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  /** Raw body, byte-for-byte as received (decoded as UTF-8). */
  body: string;
  /** Status the receiver answered with. */
  status: number;
  at: number;
}

const DEFAULT_STATUS = 200;

/**
 * A Bun HTTP server bound to an ephemeral loopback port.
 *
 * `dispose` stops the listener, so callers can always use it in `finally`.
 */
export class NotificationReceiverFixture {
  readonly requests: NotificationRequestRecord[] = [];
  readonly url: string;
  private readonly statuses = new Map<string, number>();
  private readonly server: ReturnType<typeof Bun.serve>;

  private constructor(server: ReturnType<typeof Bun.serve>) {
    this.server = server;
    const port = server.port;
    if (port === undefined) throw new Error("Bun.serve did not report an assigned port");
    this.url = `http://127.0.0.1:${port}`;
  }

  /** Start the receiver; every path answers 200 until {@link respond} changes it. */
  static start(): NotificationReceiverFixture {
    let fixture: NotificationReceiverFixture | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = new TextDecoder().decode(await request.arrayBuffer());
        const path = new URL(request.url).pathname;
        const status = fixture?.statuses.get(path) ?? DEFAULT_STATUS;
        fixture?.requests.push({
          method: request.method,
          path,
          headers: Object.fromEntries(
            [...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
          ),
          body,
          status,
          at: Date.now(),
        });
        // Slack answers a plain-text "ok"; a generic receiver's body is ignored.
        return new Response(status < 300 ? "ok" : "error", { status });
      },
    });
    fixture = new NotificationReceiverFixture(server);
    return fixture;
  }

  /** Full URL for a receiver path (for example `/hook`). */
  endpoint(path: string): string {
    return `${this.url}${path}`;
  }

  /** Answer every later request to `path` with `status`. */
  respond(path: string, status: number): void {
    this.statuses.set(path, status);
  }

  /** Requests received on one path, oldest first. */
  requestsTo(path: string): NotificationRequestRecord[] {
    return this.requests.filter((request) => request.path === path);
  }

  /** Stop the listener. */
  dispose(): void {
    this.server.stop(true);
  }
}
