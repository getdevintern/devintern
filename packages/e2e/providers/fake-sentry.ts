/**
 * In-process fake of the Sentry issues API.
 *
 * The fake implements only the endpoints the worker's error-monitor acquirer
 * calls: the project-scoped (and organization-wide) unresolved-issue list and
 * the organization issue-comment endpoint. It is deliberately independent of
 * the production Sentry client: requests are parsed as raw HTTP, and the
 * fixture owns its own in-memory issue and comment state, so a client
 * regression (wrong path, query, or response field) fails instead of being
 * mirrored by shared code.
 *
 * Routing is strict. Any request the fake does not implement returns a 404
 * whose body names the method and path, and the request is recorded so a test
 * can fail loudly even if the product ignores the error response. The same
 * applies to a correct route with an unexpected organization, project, or
 * issue id.
 *
 * The server binds `127.0.0.1:0`, accepts any Bearer token, never reads or logs
 * credentials, and never makes outbound requests.
 */

/** Issue fields the product reads from a Sentry issue-list row. */
export interface FakeSentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  level: string;
  status: string;
  /** Event count; Sentry serializes it as a string. */
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  metadata: {
    type?: string;
    value?: string;
    filename?: string;
  };
  projectSlug: string;
}

export interface FakeSentryOptions {
  /** Organization slug accepted by every route. */
  organization?: string;
  /** Project slug accepted by the project-scoped list route. */
  project?: string;
  /** Override fields on the one seeded issue. */
  issue?: Partial<FakeSentryIssue>;
}

/** One captured issue-list request, for assertions about the query the client sends. */
export interface FakeSentryListRequest {
  organization: string;
  project?: string;
  query: string | null;
  sort: string | null;
  statsPeriod: string | null;
  perPage: string | null;
}

/** One captured issue comment. */
export interface FakeSentryComment {
  issueId: string;
  text: string;
}

const DEFAULT_ISSUE: FakeSentryIssue = {
  id: "4501",
  shortId: "E2E-4501",
  title: "TypeError: cannot read properties of undefined (reading 'greeting')",
  culprit: "src/greeting.ts in greet",
  level: "error",
  status: "unresolved",
  count: "12",
  firstSeen: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-02T00:00:00.000Z",
  permalink: "https://sentry.invalid/organizations/e2e-org/issues/4501/",
  metadata: {
    type: "TypeError",
    value: "cannot read properties of undefined (reading 'greeting')",
    filename: "src/greeting.ts",
  },
  projectSlug: "e2e-project",
};

/** Sentry API fake backed entirely by in-memory state. */
export class FakeSentryServer {
  /** Requests the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedRequests: string[] = [];

  /** Every accepted issue-list read, oldest first. */
  readonly listRequests: FakeSentryListRequest[] = [];

  private readonly organization: string;
  private readonly project: string;
  private readonly issue: FakeSentryIssue;
  private readonly comments: FakeSentryComment[] = [];
  private readCount = 0;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly baseUrl: string;

  constructor(options: FakeSentryOptions = {}) {
    this.organization = options.organization ?? "e2e-org";
    this.project = options.project ?? "e2e-project";
    this.issue = { ...DEFAULT_ISSUE, ...options.issue };
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  /** Base URL the worker's `base_url` must point at. */
  get url(): string {
    return this.baseUrl;
  }

  get issueId(): string {
    return this.issue.id;
  }

  get issueShortId(): string {
    return this.issue.shortId;
  }

  get issueTitle(): string {
    return this.issue.title;
  }

  get issueCulprit(): string {
    return this.issue.culprit ?? "";
  }

  /** Number of successful issue-list reads; drives the dedupe poll assertion. */
  get issueReadCount(): number {
    return this.readCount;
  }

  /** Captured comment bodies, in the order the worker posted them. */
  get commentBodies(): string[] {
    return this.comments.map((comment) => comment.text);
  }

  /** Captured comments with their issue ids. */
  get commentRecords(): FakeSentryComment[] {
    return this.comments.map((comment) => ({ ...comment }));
  }

  /** Stop the HTTP server and release the ephemeral port. */
  async cleanup(): Promise<void> {
    this.server.stop(true);
  }

  /** Stop the server when a test cannot reach the normal cleanup path. */
  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    const projectIssues = path.match(/^\/api\/0\/projects\/([^/]+)\/([^/]+)\/issues\/$/);
    if (method === "GET" && projectIssues) {
      return this.listIssues(url, path, decode(projectIssues[1]), decode(projectIssues[2]));
    }

    const organizationIssues = path.match(/^\/api\/0\/organizations\/([^/]+)\/issues\/$/);
    if (method === "GET" && organizationIssues) {
      return this.listIssues(url, path, decode(organizationIssues[1]));
    }

    const comments = path.match(/^\/api\/0\/organizations\/([^/]+)\/issues\/([^/]+)\/comments\/$/);
    if (method === "POST" && comments) {
      return this.addComment(request, path, decode(comments[1]), decode(comments[2]));
    }

    return this.unmatched(method, path);
  }

  private listIssues(url: URL, path: string, organization: string, project?: string): Response {
    if (organization !== this.organization || (project !== undefined && project !== this.project)) {
      return this.unmatched(
        "GET",
        path,
        `unexpected scope "${organization}/${project ?? "(organization-wide)"}"`,
      );
    }

    this.readCount++;
    this.listRequests.push({
      organization,
      ...(project === undefined ? {} : { project }),
      query: url.searchParams.get("query"),
      sort: url.searchParams.get("sort"),
      statsPeriod: url.searchParams.get("statsPeriod"),
      perPage: url.searchParams.get("per_page"),
    });

    return json([this.issuePayload()]);
  }

  private async addComment(
    request: Request,
    path: string,
    organization: string,
    issueId: string,
  ): Promise<Response> {
    if (organization !== this.organization || issueId !== this.issue.id) {
      return this.unmatched(
        "POST",
        path,
        `unexpected organization "${organization}" or issue id "${issueId}"`,
      );
    }

    const body = await readJson(request);
    if (!body.ok) return body.response;
    const text = asRecord(body.value)?.text;
    if (typeof text !== "string") {
      this.unexpectedRequests.push("Fake Sentry comment request had no string text field");
      return json({ detail: "Comment text is required" }, 400);
    }

    this.comments.push({ issueId, text });
    // Sentry's comment endpoint answers with a comment payload; the client
    // only checks the status, so an empty successful response is sufficient.
    return new Response(null, { status: 201 });
  }

  private issuePayload(): Record<string, unknown> {
    return {
      id: this.issue.id,
      shortId: this.issue.shortId,
      title: this.issue.title,
      culprit: this.issue.culprit,
      level: this.issue.level,
      status: this.issue.status,
      count: this.issue.count,
      firstSeen: this.issue.firstSeen,
      lastSeen: this.issue.lastSeen,
      permalink: this.issue.permalink,
      metadata: { ...this.issue.metadata },
      project: {
        id: "1",
        slug: this.issue.projectSlug,
        name: this.issue.projectSlug,
      },
    };
  }

  private unmatched(method: string, path: string, detail?: string): Response {
    const diagnostic =
      `Unmatched fake Sentry request: ${method} ${path}` + (detail ? ` (${detail})` : "");
    this.unexpectedRequests.push(diagnostic);
    return json({ detail: diagnostic }, 404);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function decode(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: json({ detail: "Invalid JSON request body" }, 400) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
