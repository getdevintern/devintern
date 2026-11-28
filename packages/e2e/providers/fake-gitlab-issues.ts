/**
 * In-process GitLab Issues (REST v4) fake for offline worker suites.
 *
 * Implements only the issue endpoints the built Code CLI calls while the
 * worker polls GitLab Issues and gates tickets on blocking links:
 *
 * - `GET  /user`
 * - `GET  /projects/:id/issues` (`state`, `labels`, `search`, `updated_after`,
 *   `assignee_username`, `per_page`; answers with an `X-Total` header)
 * - `GET  /projects/:id/issues/:iid`, `PUT /projects/:id/issues/:iid`
 *   (`title`, `description`, `labels`, `add_labels`, `remove_labels`, `state_event`)
 * - `GET  /projects/:id/labels`
 * - `GET|POST /projects/:id/issues/:iid/notes`, `PUT …/notes/:note_id`
 * - `GET  /projects/:id/issues/:iid/links` (`link_type` relative to `:iid`)
 *
 * Tests can backdate an issue's `created_at` (one-shot `--estimate` skips
 * issues younger than 24 hours) and make one issue's links read answer an
 * HTTP error ({@link FakeGitLabIssues.failLinks}) to exercise the dependency
 * gate's fail-closed path.
 *
 * It shares no code with the product client, so a regression in a path,
 * payload, or header fails instead of being mirrored. Routing is strict: any
 * other route, or another project, answers 404 and is recorded in
 * {@link FakeGitLabIssues.unexpectedRequests}; another project's body is
 * GitLab's `404 Project Not Found`. Requests without the per-run
 * `PRIVATE-TOKEN` answer 401. The request log keeps method, path, and status
 * only; headers and the token are never stored or echoed.
 *
 * The server binds `127.0.0.1:0` and never makes outbound requests.
 */

/** GitLab issue-link types as seen from the queried issue. */
export type FakeGitLabLinkType = "relates_to" | "blocks" | "is_blocked_by";

interface FakeGitLabNote {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  updated_at: string;
}

interface FakeGitLabIssueRecord {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed";
  labels: string[];
  created_at: string;
  updated_at: string;
  notes: FakeGitLabNote[];
}

/** An issue in another project, linkable as a cross-project blocker. */
export interface FakeGitLabExternalIssue {
  projectPath: string;
  projectId: number;
  iid: number;
  state: "opened" | "closed";
}

interface FakeGitLabLink {
  id: number;
  /** Local issue iid the link is listed on. */
  from: number;
  /** Local iid, or an external issue in another project. */
  to: number | FakeGitLabExternalIssue;
  /** Type relative to `from`. */
  type: FakeGitLabLinkType;
}

/** One request the fake answered (method, path, status; never headers). */
export interface FakeGitLabRequest {
  method: string;
  path: string;
  status: number;
  at: number;
}

/** Issue-list filters the fake received (never headers or tokens). */
export interface FakeGitLabSearch {
  params: Record<string, string>;
  iids: number[];
  at: number;
}

export interface FakeGitLabIssuesOptions {
  /** Project path (`group/sub/repo`); the client URL-encodes it. */
  projectPath?: string;
  /** Labels defined on the project (the status labels must be among them). */
  labels?: string[];
}

const USER = { id: 1, username: "e2e-gitlab-user", name: "E2E GitLab User" } as const;
const PROJECT_ID = 4242;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function splitLabels(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

export class FakeGitLabIssues {
  readonly projectPath: string;
  readonly token = `glpat-fake-${crypto.randomUUID().replace(/-/g, "")}`;
  readonly projectLabels: string[];
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly issues = new Map<number, FakeGitLabIssueRecord>();
  private readonly links: FakeGitLabLink[] = [];
  private readonly log: FakeGitLabRequest[] = [];
  private readonly searches: FakeGitLabSearch[] = [];
  private readonly unexpected: FakeGitLabRequest[] = [];
  /** Per-issue HTTP status the links endpoint answers instead of the links. */
  private readonly linkFaults = new Map<number, number>();
  private nextIid = 1;
  private nextNoteId = 1000;
  private nextLinkId = 1;
  private lastStamp = 0;
  private stopped = false;

  constructor(options: FakeGitLabIssuesOptions = {}) {
    this.projectPath = options.projectPath ?? "e2e-group/fake-issues";
    this.projectLabels = [...(options.labels ?? [])];
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  /** Instance root (no `/api/v4`), as `GITLAB_BASE_URL` expects. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Tracker variables for the worker; the token is random per run. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: "gitlab",
      GITLAB_TOKEN: this.token,
      GITLAB_PROJECT: this.projectPath,
      GITLAB_BASE_URL: this.baseUrl,
    };
  }

  // ------------------------------------------------------------------
  // Test-side helpers (no HTTP)
  // ------------------------------------------------------------------

  createIssue(input: {
    title: string;
    description: string;
    labels?: string[];
    state?: "opened" | "closed";
    /** ISO `created_at` override (e.g. two days ago); `updated_at` stays now. */
    createdAt?: string;
  }): { iid: number; key: string } {
    const iid = this.nextIid++;
    const stamp = this.stamp();
    if (input.createdAt !== undefined && Number.isNaN(Date.parse(input.createdAt))) {
      throw new Error(`Invalid fake GitLab createdAt: ${input.createdAt}`);
    }
    this.issues.set(iid, {
      id: 90_000 + iid,
      iid,
      title: input.title,
      description: input.description,
      state: input.state ?? "opened",
      labels: [...(input.labels ?? [])],
      created_at: input.createdAt ?? stamp,
      updated_at: stamp,
      notes: [],
    });
    return { iid, key: String(iid) };
  }

  /**
   * Link `dependent` as blocked by `blocker`. GitLab lists the pair on both
   * sides: `is_blocked_by` on the dependent, `blocks` on a local blocker.
   */
  linkBlockedBy(dependent: number, blocker: number | FakeGitLabExternalIssue): void {
    this.link(dependent, blocker, "is_blocked_by");
    if (typeof blocker === "number") this.link(blocker, dependent, "blocks");
  }

  /** Add a link listed on `from` only (`relates_to`, `blocks`, …). */
  link(from: number, to: number | FakeGitLabExternalIssue, type: FakeGitLabLinkType): void {
    this.require(from);
    if (typeof to === "number") this.require(to);
    this.links.push({ id: this.nextLinkId++, from, to, type });
  }

  /**
   * Make `GET …/issues/:iid/links` of one issue answer `status` (a 5xx by
   * default) until {@link clearLinkFault}. Other issues and routes are
   * unaffected.
   */
  failLinks(iid: number, status = 503): void {
    this.require(iid);
    if (status < 400 || status > 599) throw new Error(`Not an HTTP error status: ${status}`);
    this.linkFaults.set(iid, status);
  }

  clearLinkFault(iid: number): void {
    this.linkFaults.delete(iid);
  }

  closeIssue(iid: number): void {
    const issue = this.require(iid);
    issue.state = "closed";
    issue.updated_at = this.stamp();
  }

  /** Bump `updated_at`, as a human edit would, so the change detector sees it. */
  touch(iid: number): void {
    this.require(iid).updated_at = this.stamp();
  }

  issue(iid: number): Readonly<FakeGitLabIssueRecord> {
    return this.require(iid);
  }

  labelsOf(iid: number): string[] {
    return [...this.require(iid).labels];
  }

  /** Human (non-system) notes on an issue. */
  notesOf(iid: number): FakeGitLabNote[] {
    return this.require(iid).notes.filter((note) => !note.system);
  }

  requests(): FakeGitLabRequest[] {
    return [...this.log];
  }

  /** Issue-list requests with their filters and returned iids. */
  searchRequests(): FakeGitLabSearch[] {
    return [...this.searches];
  }

  /** Requests to routes or projects the fake does not implement. */
  get unexpectedRequests(): FakeGitLabRequest[] {
    return [...this.unexpected];
  }

  /** Blocker reads (`GET …/issues/:iid/links`) of one issue. */
  linkReads(iid: number): FakeGitLabRequest[] {
    const suffix = `/issues/${iid}/links`;
    return this.log.filter((request) => request.method === "GET" && request.path.endsWith(suffix));
  }

  /** Writes (`PUT`/`POST`) addressed to one issue or its notes. */
  writesTo(iid: number): FakeGitLabRequest[] {
    const marker = `/issues/${iid}`;
    return this.log.filter(
      (request) =>
        request.method !== "GET" &&
        (request.path.endsWith(marker) || request.path.includes(`${marker}/`)),
    );
  }

  async cleanup(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.server.stop(true);
  }

  // ------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const entry: FakeGitLabRequest = {
      method: request.method,
      path: url.pathname,
      status: 0,
      at: Date.now(),
    };
    this.log.push(entry);
    let response: Response;
    if (request.headers.get("private-token") !== this.token) {
      response = json({ message: "401 Unauthorized" }, 401);
    } else {
      response = (await this.route(request, url)) ?? this.notFound(entry);
    }
    entry.status = response.status;
    return response;
  }

  private notFound(entry: FakeGitLabRequest): Response {
    this.unexpected.push(entry);
    // Another project gets GitLab's own body, as for a project the token cannot see.
    if (entry.path.startsWith("/api/v4/projects/") && !entry.path.startsWith(this.projectPrefix)) {
      return json({ message: "404 Project Not Found" }, 404);
    }
    return json({ message: `404 Not Found: ${entry.method} ${entry.path}` }, 404);
  }

  private get projectPrefix(): string {
    return `/api/v4/projects/${encodeURIComponent(this.projectPath)}/`;
  }

  private async route(request: Request, url: URL): Promise<Response | undefined> {
    const method = request.method;
    const path = url.pathname;
    if (method === "GET" && path === "/api/v4/user") return json(USER);

    const prefix = `/api/v4/projects/${encodeURIComponent(this.projectPath)}`;
    if (!path.startsWith(`${prefix}/`)) return undefined;
    const rest = path.slice(prefix.length);

    if (method === "GET" && rest === "/labels") return this.listLabels();
    if (method === "GET" && rest === "/issues") return this.searchIssues(url);

    const issueMatch = rest.match(/^\/issues\/(\d+)(\/.*)?$/);
    if (!issueMatch) return undefined;
    const issue = this.issues.get(Number(issueMatch[1]));
    if (!issue) return undefined;
    const sub = issueMatch[2] ?? "";

    if (sub === "") {
      if (method === "GET") return json(this.render(issue));
      if (method === "PUT") return json(this.render(this.update(issue, await readBody(request))));
      return undefined;
    }
    if (sub === "/links" && method === "GET") {
      const fault = this.linkFaults.get(issue.iid);
      if (fault !== undefined) return json({ message: `${fault} Injected fault` }, fault);
      return json(this.renderLinks(issue.iid));
    }
    if (sub === "/notes") {
      if (method === "GET") return json(issue.notes.map((note) => ({ ...note, author: USER })));
      if (method === "POST") {
        const body = await readBody(request);
        if (typeof body.body !== "string" || !body.body) return json({ message: "body" }, 400);
        const stamp = this.stamp();
        const note: FakeGitLabNote = {
          id: this.nextNoteId++,
          body: body.body,
          system: false,
          created_at: stamp,
          updated_at: stamp,
        };
        issue.notes.push(note);
        issue.updated_at = stamp;
        return json({ ...note, author: USER }, 201);
      }
      return undefined;
    }
    const noteMatch = sub.match(/^\/notes\/(\d+)$/);
    if (noteMatch && method === "PUT") {
      const note = issue.notes.find((candidate) => candidate.id === Number(noteMatch[1]));
      const body = await readBody(request);
      if (!note || typeof body.body !== "string") return undefined;
      note.body = body.body;
      note.updated_at = this.stamp();
      issue.updated_at = note.updated_at;
      return json({ ...note, author: USER });
    }
    return undefined;
  }

  private listLabels(): Response {
    // One page: the fake's catalog is far below `per_page=100`.
    return json(
      this.projectLabels.map((name, index) => ({ id: 500 + index, name, description: null })),
    );
  }

  private searchIssues(url: URL): Response {
    const params = Object.fromEntries(url.searchParams.entries());
    const labels = splitLabels(params.labels);
    const search = params.search?.toLowerCase();
    const updatedAfter = params.updated_after ? Date.parse(params.updated_after) : undefined;
    const matches = [...this.issues.values()].filter((issue) => {
      if (params.state && issue.state !== params.state) return false;
      if (labels.some((label) => !issue.labels.includes(label))) return false;
      if (params.assignee_username) return false; // nobody is assigned in the fake
      if (
        search &&
        !issue.title.toLowerCase().includes(search) &&
        !issue.description.toLowerCase().includes(search)
      ) {
        return false;
      }
      if (updatedAfter !== undefined && Date.parse(issue.updated_at) < updatedAfter) return false;
      return true;
    });
    // GitLab default order: created_at desc.
    matches.sort((a, b) => b.iid - a.iid);
    const perPage = Number(params.per_page ?? "20") || 20;
    const page = matches.slice(0, perPage);
    this.searches.push({ params, iids: page.map((issue) => issue.iid), at: Date.now() });
    return json(
      page.map((issue) => this.render(issue)),
      200,
      { "X-Total": String(matches.length) },
    );
  }

  private update(
    issue: FakeGitLabIssueRecord,
    body: Record<string, unknown>,
  ): FakeGitLabIssueRecord {
    let changed = false;
    if (typeof body.title === "string") {
      issue.title = body.title;
      changed = true;
    }
    if (typeof body.description === "string") {
      issue.description = body.description;
      changed = true;
    }
    if (typeof body.labels === "string") {
      issue.labels = splitLabels(body.labels);
      changed = true;
    }
    for (const label of splitLabels(body.add_labels)) {
      if (!issue.labels.includes(label)) issue.labels.push(label);
      changed = true;
    }
    const removed = splitLabels(body.remove_labels);
    if (removed.length > 0) {
      issue.labels = issue.labels.filter((label) => !removed.includes(label));
      changed = true;
    }
    if (body.state_event === "close") {
      issue.state = "closed";
      changed = true;
    } else if (body.state_event === "reopen") {
      issue.state = "opened";
      changed = true;
    }
    if (changed) issue.updated_at = this.stamp();
    return issue;
  }

  private render(issue: FakeGitLabIssueRecord) {
    return {
      id: issue.id,
      iid: issue.iid,
      project_id: PROJECT_ID,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      labels: [...issue.labels],
      author: { username: USER.username },
      assignees: [],
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      web_url: `${this.baseUrl}/${this.projectPath}/-/issues/${issue.iid}`,
      references: { full: `${this.projectPath}#${issue.iid}` },
    };
  }

  private renderLinks(iid: number) {
    return this.links
      .filter((link) => link.from === iid)
      .map((link) => {
        const base =
          typeof link.to === "number"
            ? this.render(this.require(link.to))
            : {
                id: 80_000 + link.to.iid,
                iid: link.to.iid,
                project_id: link.to.projectId,
                title: `External ${link.to.projectPath}#${link.to.iid}`,
                state: link.to.state,
                web_url: `${this.baseUrl}/${link.to.projectPath}/-/issues/${link.to.iid}`,
                references: { full: `${link.to.projectPath}#${link.to.iid}` },
              };
        return { ...base, issue_link_id: link.id, link_type: link.type };
      });
  }

  private require(iid: number): FakeGitLabIssueRecord {
    const issue = this.issues.get(iid);
    if (!issue) throw new Error(`Fake GitLab has no issue #${iid}`);
    return issue;
  }

  /** Strictly increasing wall-clock ISO stamp (the detector filters by real time). */
  private stamp(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
