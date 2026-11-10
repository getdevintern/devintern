/**
 * Loopback stand-in for the DevIntern report endpoint.
 *
 * The report CLI only needs one JSON POST. Recording every request lets tests
 * prove that `--print`/`--save` never touch the network and that `--from` posts
 * the exact payload that was previewed. Tests can swap the reply to exercise a
 * rejected submission and then retry against the same server.
 */

/** One request the CLI made to the fake endpoint. */
export interface ReportRequestRecord {
  method: string;
  path: string;
  body: string;
}

interface ReportServerReply {
  status: number;
  body: unknown;
}

const DEFAULT_REPLY: ReportServerReply = {
  status: 201,
  body: {
    id: "e2e-report-receipt",
    url: "https://devintern.test/reports/e2e-report-receipt",
    receipt: "e2e-report-receipt",
  },
};

/**
 * A Bun HTTP server bound to an ephemeral loopback port.
 *
 * `dispose` stops the listener, so callers can always use it in `finally`.
 */
export class ReportServerFixture {
  readonly requests: ReportRequestRecord[] = [];
  readonly url: string;
  private reply: ReportServerReply = DEFAULT_REPLY;
  private readonly server: ReturnType<typeof Bun.serve>;

  private constructor(server: ReturnType<typeof Bun.serve>) {
    this.server = server;
    const port = server.port;
    if (port === undefined) throw new Error("Bun.serve did not report an assigned port");
    this.url = `http://127.0.0.1:${port}`;
  }

  /** Start the fake endpoint with a successful receipt. */
  static async start(): Promise<ReportServerFixture> {
    let fixture: ReportServerFixture | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text();
        fixture?.requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body,
        });
        const reply = fixture?.reply ?? DEFAULT_REPLY;
        return Response.json(reply.body, { status: reply.status });
      },
    });
    fixture = new ReportServerFixture(server);
    return fixture;
  }

  /** Endpoint the CLI should post to. */
  get endpoint(): string {
    return `${this.url}/api/reports`;
  }

  /** Replace the response returned to every subsequent request. */
  respond(status: number, body: unknown): void {
    this.reply = { status, body };
  }

  /** Stop the listener. */
  dispose(): void {
    this.server.stop(true);
  }
}
