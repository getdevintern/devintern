/**
 * In-process Jira Cloud REST v3 fake.
 *
 * The fake implements only the endpoints the built Code CLI calls for a task
 * lifecycle. It is deliberately independent of the product Jira client: the
 * server parses raw HTTP requests and the fixture reads its own in-memory
 * state, so a client regression (wrong path, payload, or field) fails instead
 * of being mirrored by shared code.
 *
 * Routing is strict. Any request the fake does not implement returns a 404
 * whose body names the method and path, and the request is recorded so a test
 * can fail loudly even if the product ignores the error response.
 *
 * The server binds `127.0.0.1:0`, accepts any Basic-auth credentials, never
 * logs them, and never makes outbound requests.
 */

import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

/** ADF node subset used for issue descriptions and comment bodies. */
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

interface FakeJiraComment {
  id: string;
  body: AdfNode;
  renderedBody: string;
  created: string;
  updated: string;
}

interface FakeJiraIssue {
  key: string;
  id: string;
  summary: string;
  description: AdfNode;
  status: string;
  labels: string[];
  comments: FakeJiraComment[];
  /** Custom fields written through `PUT /rest/api/3/issue/{key}`. */
  fields: Record<string, unknown>;
  created: string;
  updated: string;
}

/** Workflow statuses the fake exposes through its transitions endpoint. */
export interface FakeJiraStatuses {
  todo: string;
  inProgress: string;
  pr: string;
  done: string;
}

/** Distinct workflow statuses used by the fake by default. */
export const FAKE_JIRA_STATUSES: FakeJiraStatuses = {
  todo: "To Do",
  inProgress: "In Progress",
  pr: "In Review",
  done: "Done",
};

export interface FakeJiraOptions {
  /** Jira project key; issue keys are `<projectKey>-<number>`. */
  projectKey?: string;
  /** Override one or more workflow status names. */
  statuses?: Partial<FakeJiraStatuses>;
}

const FAKE_ACCOUNT = {
  accountId: "fake-account",
  displayName: "E2E Jira User",
  emailAddress: "e2e@example.invalid",
} as const;

const FAKE_EMAIL = "e2e@example.invalid";
const FAKE_API_TOKEN = "fake-jira-api-token";

/** Render ADF as plain text, preserving heading levels for readable assertions. */
function adfToText(node: AdfNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "emoji") return String(node.attrs?.text ?? "");
  if (node.type === "hardBreak") return "\n";

  const children = node.content ?? [];
  const inner = children.map(adfToText);

  switch (node.type) {
    case "doc":
      return inner.filter(Boolean).join("\n\n");
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return `${"#".repeat(level)} ${inner.join("")}`;
    }
    case "paragraph":
      return inner.join("");
    case "bulletList":
      return children.map((child) => `- ${adfToText(child)}`).join("\n");
    case "orderedList":
      return children.map((child, index) => `${index + 1}. ${adfToText(child)}`).join("\n");
    case "listItem":
      return inner.join("");
    case "panel":
      return inner.filter(Boolean).join("\n");
    default:
      return inner.join("");
  }
}

/** Build a minimal ADF document from plain text. */
function textToAdf(text: string): AdfNode {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return {
    type: "doc",
    content:
      paragraphs.length > 0
        ? paragraphs.map((paragraph) => ({
            type: "paragraph",
            content: [{ type: "text", text: paragraph }],
          }))
        : [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function adfToHtml(node: AdfNode): string {
  return `<p>${escapeHtml(adfToText(node)).replace(/\n/g, "<br>")}</p>`;
}

/** Jira-shaped ticket fixture backed entirely by in-memory state. */
export class FakeJiraTracker implements TrackerFixture {
  readonly type = "jira";
  readonly statusKind = "state" as const;
  readonly openState: string;
  readonly statuses: FakeJiraStatuses;
  readonly projectKeyValue: string;

  /** Requests the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedRequests: string[] = [];

  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly baseUrl: string;
  private readonly issues = new Map<string, FakeJiraIssue>();
  private nextIssueNumber = 1;
  private nextCommentId = 10_000;
  private now = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(options: FakeJiraOptions = {}) {
    this.projectKeyValue = options.projectKey ?? "E2E";
    this.statuses = { ...FAKE_JIRA_STATUSES, ...options.statuses };
    this.openState = this.statuses.todo;

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  /** Base URL the CLI subprocess must use. */
  get url(): string {
    return this.baseUrl;
  }

  /** Tracker configuration/credentials for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      JIRA_BASE_URL: this.baseUrl,
      JIRA_EMAIL: FAKE_EMAIL,
      JIRA_API_TOKEN: FAKE_API_TOKEN,
      JIRA_DEFAULT_PROJECT_KEY: this.projectKeyValue,
    };
  }

  /** Project key `resolveProjectKey` derives from the issue key prefix. */
  projectKey(): string {
    return this.projectKeyValue;
  }

  /** Jira labels are issue fields; no project label creation is required. */
  async ensureLabels(_labels: string[]): Promise<void> {}

  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const key = `${this.projectKeyValue}-${this.nextIssueNumber++}`;
    const timestamp = this.timestamp();
    const issue: FakeJiraIssue = {
      key,
      id: String(10_000 + this.nextIssueNumber),
      summary: input.title,
      description: textToAdf(input.body),
      status: this.statuses.todo,
      labels: [...(input.labels ?? [])],
      comments: [],
      fields: {},
      created: timestamp,
      updated: timestamp,
    };
    this.issues.set(key, issue);
    return { key, url: `${this.baseUrl}/browse/${key}` };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const issue = this.requireIssue(ticketKey);
    const id = String(this.nextCommentId++);
    const timestamp = this.timestamp();
    const adf = textToAdf(body);
    issue.comments.push({
      id,
      body: adf,
      renderedBody: adfToHtml(adf),
      created: timestamp,
      updated: timestamp,
    });
    issue.updated = timestamp;
    return id;
  }

  /** Close a scenario-owned issue by moving it to its terminal status. */
  async closeTicket(ticketKey: string): Promise<void> {
    const issue = this.requireIssue(ticketKey);
    issue.status = this.statuses.done;
    issue.updated = this.timestamp();
  }

  async deleteComment(commentId: string): Promise<void> {
    for (const issue of this.issues.values()) {
      const index = issue.comments.findIndex((comment) => comment.id === commentId);
      if (index >= 0) {
        issue.comments.splice(index, 1);
        issue.updated = this.timestamp();
        return;
      }
    }
    throw new Error(`Fake Jira comment not found: ${commentId}`);
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const issue = this.requireIssue(ticketKey);
    return {
      state: issue.status,
      labels: [...issue.labels],
      body: adfToText(issue.description),
    };
  }

  /** Current workflow status, which is what {@link TrackerTicketState.state} holds. */
  async getStatus(ticketKey: string): Promise<string> {
    return this.requireIssue(ticketKey).status;
  }

  /**
   * Move the deterministic fake clock so a ticket can be created "now" for the
   * estimation <24h skip. Later timestamped writes continue from this instant.
   *
   * @param epochMs - Epoch milliseconds to use as the server's current time
   */
  setNow(epochMs: number): void {
    if (!Number.isFinite(epochMs)) throw new Error(`Invalid fake Jira clock: ${epochMs}`);
    this.now = epochMs;
  }

  /** Read one persisted custom field, or `undefined` when it was never written. */
  getField(ticketKey: string, fieldId: string): unknown {
    return this.requireIssue(ticketKey).fields[fieldId];
  }

  /**
   * Story points written to the convention field used by the estimation test.
   *
   * @param ticketKey - Issue key
   * @param fieldId - Jira custom field id (default `customfield_10016`)
   */
  getStoryPoints(ticketKey: string, fieldId = "customfield_10016"): unknown {
    return this.getField(ticketKey, fieldId);
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    const issue = this.requireIssue(ticketKey);
    return issue.comments.map((comment) => ({ id: comment.id, body: adfToText(comment.body) }));
  }

  /**
   * Evaluate the small JQL subset the offline scenario uses: quoted search
   * terms (for example `text ~ "<marker>"`) must appear in the summary or
   * description. The decoy is excluded because it lacks the marker.
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    return this.matchingIssues(query).map((issue) => ({
      key: issue.key,
      url: `${this.baseUrl}/browse/${issue.key}`,
    }));
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
    const path = decodeURIComponent(url.pathname);
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/rest/api/3/myself") {
      return json(FAKE_ACCOUNT);
    }

    if (method === "GET" && path === "/rest/api/3/search/jql") {
      return this.search(url);
    }

    const issueMatch = path.match(/^\/rest\/api\/3\/issue\/([^/]+)$/);
    if (issueMatch?.[1] && method === "GET") {
      return this.getIssue(issueMatch[1]);
    }
    if (issueMatch?.[1] && method === "PUT") {
      return this.updateIssue(issueMatch[1], request);
    }

    const commentMatch = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/comment$/);
    if (commentMatch?.[1] && method === "GET") {
      return this.getComments(commentMatch[1]);
    }
    if (commentMatch?.[1] && method === "POST") {
      return this.postComment(commentMatch[1], request);
    }

    const commentUpdateMatch = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/comment\/([^/]+)$/);
    if (commentUpdateMatch?.[1] && commentUpdateMatch[2] && method === "PUT") {
      return this.updateComment(commentUpdateMatch[1], commentUpdateMatch[2], request);
    }

    const transitionMatch = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
    if (transitionMatch?.[1] && method === "GET") {
      return this.getTransitions(transitionMatch[1]);
    }
    if (transitionMatch?.[1] && method === "POST") {
      return this.postTransition(transitionMatch[1], request);
    }

    const diagnostic = `Unmatched fake Jira request: ${method} ${path}`;
    this.unexpectedRequests.push(diagnostic);
    return json({ errorMessages: [diagnostic] }, 404);
  }

  private search(url: URL): Response {
    const jql = url.searchParams.get("jql") ?? "";
    const startAt = Number(url.searchParams.get("startAt") ?? 0);
    const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
    const matches = this.matchingIssues(jql);
    return json({
      startAt,
      maxResults,
      total: matches.length,
      issues: matches.slice(startAt, startAt + maxResults).map((issue) => this.issuePayload(issue)),
    });
  }

  private matchingIssues(query: string): FakeJiraIssue[] {
    const quoted = [...query.matchAll(/["']([^"']+)["']/g)]
      .map((match) => match[1]?.trim())
      .filter((term): term is string => Boolean(term));
    const terms = quoted.length > 0 ? quoted : [query.trim()].filter(Boolean);
    if (terms.length === 0) return [...this.issues.values()];
    return [...this.issues.values()].filter((issue) => {
      const searchable = `${issue.summary}\n${adfToText(issue.description)}`.toLowerCase();
      return terms.every((term) => searchable.includes(term.toLowerCase()));
    });
  }

  private getIssue(key: string): Response {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    return json(this.issuePayload(issue));
  }

  private async updateIssue(key: string, request: Request): Promise<Response> {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const fields = asRecord(asRecord(body.value)?.fields);
    if (Array.isArray(fields?.labels)) {
      issue.labels = fields.labels.filter((label): label is string => typeof label === "string");
    }
    if (typeof fields?.summary === "string") {
      issue.summary = fields.summary;
    }
    if (fields?.description && typeof fields.description === "object") {
      issue.description = fields.description as AdfNode;
    }
    // Persist every other field verbatim (notably story-point custom fields) so
    // a test can read back the value the CLI actually wrote.
    for (const [fieldId, value] of Object.entries(fields ?? {})) {
      if (fieldId === "labels" || fieldId === "summary" || fieldId === "description") continue;
      issue.fields[fieldId] = value;
    }
    issue.updated = this.timestamp();
    return new Response(null, { status: 204 });
  }

  private getComments(key: string): Response {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    return json({
      startAt: 0,
      maxResults: issue.comments.length,
      total: issue.comments.length,
      comments: issue.comments.map((comment) => this.commentPayload(comment)),
    });
  }

  private async postComment(key: string, request: Request): Promise<Response> {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const container = asRecord(body.value);
    const rawBody = container?.body;
    const adf =
      rawBody && typeof rawBody === "object"
        ? (rawBody as AdfNode)
        : textToAdf(typeof rawBody === "string" ? rawBody : "");
    const id = String(this.nextCommentId++);
    const timestamp = this.timestamp();
    const comment: FakeJiraComment = {
      id,
      body: adf,
      renderedBody: adfToHtml(adf),
      created: timestamp,
      updated: timestamp,
    };
    issue.comments.push(comment);
    issue.updated = timestamp;
    return json(this.commentPayload(comment), 201);
  }

  private async updateComment(key: string, commentId: string, request: Request): Promise<Response> {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    const comment = issue.comments.find((candidate) => candidate.id === commentId);
    if (!comment) {
      return json({ errorMessages: [`Fake Jira comment not found: ${commentId}`] }, 404);
    }
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const container = asRecord(body.value);
    const rawBody = container?.body;
    const adf =
      rawBody && typeof rawBody === "object"
        ? (rawBody as AdfNode)
        : textToAdf(typeof rawBody === "string" ? rawBody : "");
    const timestamp = this.timestamp();
    comment.body = adf;
    comment.renderedBody = adfToHtml(adf);
    comment.updated = timestamp;
    issue.updated = timestamp;
    return json(this.commentPayload(comment));
  }

  private getTransitions(key: string): Response {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    return json({
      transitions: this.allStatusNames()
        .filter((name) => name !== issue.status)
        .map((name) => ({
          id: this.statusId(name),
          name: `Transition to ${name}`,
          to: { id: this.statusId(name), name },
        })),
    });
  }

  private async postTransition(key: string, request: Request): Promise<Response> {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) return notFound(key);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const transition = asRecord(asRecord(body.value)?.transition);
    const id = typeof transition?.id === "string" ? transition.id : String(transition?.id ?? "");
    const target = this.allStatusNames().find((name) => this.statusId(name) === id);
    if (!target) {
      this.unexpectedRequests.push(`Unknown transition id "${id}" for ${issue.key}`);
      return json({ errorMessages: [`Unknown transition id: ${id}`] }, 400);
    }
    issue.status = target;
    issue.updated = this.timestamp();
    return new Response(null, { status: 204 });
  }

  private issuePayload(issue: FakeJiraIssue): Record<string, unknown> {
    const statusId = this.statusId(issue.status);
    return {
      id: issue.id,
      key: issue.key,
      self: `${this.baseUrl}/rest/api/3/issue/${issue.key}`,
      fields: {
        ...issue.fields,
        summary: issue.summary,
        description: issue.description,
        issuetype: { id: "10001", name: "Task", subtask: false },
        status: {
          id: statusId,
          name: issue.status,
          statusCategory: { key: "new", name: "To Do" },
        },
        priority: { id: "3", name: "Medium" },
        assignee: { displayName: "E2E Assignee", emailAddress: FAKE_EMAIL },
        reporter: { displayName: "E2E Reporter", emailAddress: FAKE_EMAIL },
        created: issue.created,
        updated: issue.updated,
        labels: [...issue.labels],
        components: [],
        fixVersions: [],
      },
      renderedFields: { description: adfToHtml(issue.description) },
    };
  }

  private commentPayload(comment: FakeJiraComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      renderedBody: comment.renderedBody,
      author: { displayName: FAKE_ACCOUNT.displayName, accountId: FAKE_ACCOUNT.accountId },
      created: comment.created,
      updated: comment.updated,
    };
  }

  private allStatusNames(): string[] {
    return [
      ...new Set([
        this.statuses.todo,
        this.statuses.inProgress,
        this.statuses.pr,
        this.statuses.done,
      ]),
    ];
  }

  private statusId(name: string): string {
    return String(this.allStatusNames().indexOf(name) + 1);
  }

  private requireIssue(key: string): FakeJiraIssue {
    const issue = this.issues.get(key.toUpperCase());
    if (!issue) throw new Error(`Fake Jira issue not found: ${key}`);
    return issue;
  }

  private timestamp(): string {
    this.now += 1000;
    return new Date(this.now).toISOString();
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(key: string): Response {
  return json({ errorMessages: [`Fake Jira issue not found: ${key}`] }, 404);
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: json({ errorMessages: ["Invalid JSON request body"] }, 400) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
