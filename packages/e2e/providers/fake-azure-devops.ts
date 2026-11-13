/**
 * In-process Azure DevOps WIT fake.
 *
 * The fake implements only the endpoints the built Code CLI calls for a
 * work-item lifecycle. It is deliberately independent of the product Azure
 * DevOps client: the server parses raw HTTP requests and the fixture reads its
 * own in-memory state, so a client regression (wrong path, payload, field, or
 * auth shape) fails instead of being mirrored by shared code.
 *
 * Routing is strict. Any request the fake does not implement returns a 404
 * whose body names the method and path, and the request is recorded so a test
 * can fail loudly even if the product ignores the error response.
 *
 * The server binds `127.0.0.1:0`, accepts any Basic-auth credentials without
 * logging or echoing them, and never makes outbound requests.
 */

import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

interface FakeAzureDevOpsComment {
  id: number;
  text: string;
  createdBy: { displayName: string };
  createdDate: string;
  modifiedDate: string;
}

interface FakeAzureDevOpsWorkItem {
  id: number;
  fields: Record<string, unknown>;
  comments: FakeAzureDevOpsComment[];
}

/** Workflow states the fake stores on seeded work items. */
export interface FakeAzureDevOpsStatuses {
  todo: string;
  inProgress: string;
  pr: string;
  done: string;
}

/** Distinct Agile-process workflow states used by the fake by default. */
export const FAKE_AZURE_DEVOPS_STATUSES: FakeAzureDevOpsStatuses = {
  todo: "New",
  inProgress: "Active",
  pr: "Resolved",
  done: "Closed",
};

export interface FakeAzureDevOpsOptions {
  /** Organization segment in the organization root URL (`/<org>`). */
  organization?: string;
  /** Project name used for WIQL and comments routes. */
  project?: string;
  /** Override one or more workflow state names. */
  statuses?: Partial<FakeAzureDevOpsStatuses>;
}

const FAKE_IDENTITY = { displayName: "E2E Azure DevOps User" } as const;
const FAKE_PAT = "fake-azure-devops-pat";

/** Escape HTML characters so seeded markdown text cannot inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a small markdown subset (headings, blank-line paragraphs, line
 * breaks) as the HTML Azure DevOps stores in `System.Description` and comments.
 */
function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    paragraph = [];
  };

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(`<h${level}>${escapeHtml(heading[2].trim())}</h${level}>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.join("\n") || "<p> </p>";
}

/**
 * Convert stored comment/description HTML to readable plain text.
 *
 * Headings keep their markdown level (`<h2>` -> `## `) so lifecycle assertions
 * can see the literal `## What changed` heading the product posts, while the
 * product's own HTML-to-text conversion remains free to differ.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_match, level: string, inner: string) => {
      return `${"#".repeat(Number(level))} ${stripTags(inner).trim()}`;
    })
    .replace(/<li[^>]*>(.*?)<\/li>/gis, (_match, inner: string) => `- ${stripTags(inner).trim()}`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip tags for the inner text of a block whose formatting is rendered separately. */
function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Tags are stored as a single semicolon-separated `System.Tags` string. */
function parseTags(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  return value
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function serializeTags(tags: string[]): string {
  return tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * Evaluate the WIQL subset the offline scenario uses.
 *
 * Supported: a `WHERE` containing `AND`-joined `[Field] OP 'value'` clauses
 * with `=`, `<>`, `CONTAINS`, or `NOT CONTAINS`. Field values are compared
 * case-insensitively over the stored text. A query with a `WHERE` the fake
 * cannot parse returns no rows instead of every row, so a selector regression
 * cannot pass by matching the decoy.
 */
function matchWorkItems(
  query: string,
  workItems: FakeAzureDevOpsWorkItem[],
): { matches: FakeAzureDevOpsWorkItem[]; error?: string } {
  const whereIndex = query.search(/\bWHERE\b/i);
  if (whereIndex === -1) return { matches: workItems };

  const whereClause = query.slice(whereIndex + "WHERE".length);
  const clausePattern =
    /\[([^\]]+)\]\s*(=|<>|!=|CONTAINS\s+WORDS|CONTAINS|NOT\s+CONTAINS)\s*'([^']*)'/gi;
  const clauseMatches = [...whereClause.matchAll(clausePattern)];
  const clauses = clauseMatches.map((match) => ({
    field: (match[1] ?? "").trim().toLowerCase(),
    operator: (match[2] ?? "").replace(/\s+/g, " ").toUpperCase(),
    value: match[3] ?? "",
  }));

  // Every non-clause token must be a boolean joiner or grouping whitespace.
  // Anything else (`IN`, `UNDER`, `>`, `WAS EVER`, …) is unsupported, so fail
  // loudly instead of silently dropping the clause and over-matching.
  const remainder = whereClause.replace(clausePattern, " ");
  const onlyJoiners = /^(?:\s|\(|\)|\bAND\b)*$/i.test(remainder);

  if (clauses.length === 0 || /\bOR\b/i.test(whereClause) || !onlyJoiners) {
    return { matches: [], error: `Unsupported fake Azure DevOps WIQL: ${query}` };
  }

  const matches = workItems.filter((workItem) =>
    clauses.every((clause) => {
      const actual = fieldText(workItem, clause.field);
      switch (clause.operator) {
        case "=":
          return actual.toLowerCase() === clause.value.toLowerCase();
        case "<>":
        case "!=":
          return actual.toLowerCase() !== clause.value.toLowerCase();
        case "CONTAINS":
        case "CONTAINS WORDS":
          return actual.toLowerCase().includes(clause.value.toLowerCase());
        case "NOT CONTAINS":
          return !actual.toLowerCase().includes(clause.value.toLowerCase());
        default:
          return false;
      }
    }),
  );

  return { matches };
}

/** Read the text a WIQL clause compares for a work item field. */
function fieldText(workItem: FakeAzureDevOpsWorkItem, field: string): string {
  if (field === "system.id") return String(workItem.id);
  const value = workItem.fields[canonicalFieldName(field)];
  if (Array.isArray(value)) return value.join("; ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

/** Map a case-folded WIQL field reference back to its canonical name. */
function canonicalFieldName(field: string): string {
  const fields = [
    "System.Id",
    "System.Title",
    "System.Description",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.CreatedBy",
    "System.CreatedDate",
    "System.ChangedDate",
    "System.Tags",
    "Microsoft.VSTS.Scheduling.StoryPoints",
  ];
  return fields.find((candidate) => candidate.toLowerCase() === field) ?? field;
}

/** Azure DevOps-shaped work-item fixture backed entirely by in-memory state. */
export class FakeAzureDevOpsTracker implements TrackerFixture {
  readonly type = "azure-devops";
  readonly statusKind = "state" as const;
  readonly openState: string;
  readonly statuses: FakeAzureDevOpsStatuses;
  readonly organization: string;
  readonly project: string;
  readonly baseUrl: string;

  /** Requests the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedRequests: string[] = [];

  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly workItems = new Map<number, FakeAzureDevOpsWorkItem>();
  private nextWorkItemId = 100;
  private nextCommentId = 10_000;
  private now = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(options: FakeAzureDevOpsOptions = {}) {
    this.organization = options.organization ?? "fakeorg";
    this.project = options.project ?? "FixtureProject";
    this.statuses = { ...FAKE_AZURE_DEVOPS_STATUSES, ...options.statuses };
    this.openState = this.statuses.todo;

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}/${this.organization}`;
  }

  /** Organization root URL the CLI must use (includes the organization segment). */
  get url(): string {
    return this.baseUrl;
  }

  /** Tracker configuration/credentials for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      AZURE_DEVOPS_ORG: this.organization,
      AZURE_DEVOPS_PAT: FAKE_PAT,
      AZURE_DEVOPS_PROJECT: this.project,
      AZURE_DEVOPS_BASE_URL: this.baseUrl,
      DEVINTERN_E2E_FAKE_AZURE_DEVOPS: "1",
    };
  }

  /** Project key `resolveProjectKey` derives from the tracker configuration. */
  projectKey(): string {
    return this.project;
  }

  /** Tags are work-item fields; no project tag creation is required. */
  async ensureLabels(_labels: string[]): Promise<void> {}

  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const timestamp = this.timestamp();
    const workItem: FakeAzureDevOpsWorkItem = {
      id: this.nextWorkItemId++,
      fields: {
        "System.Title": input.title,
        "System.Description": markdownToHtml(input.body),
        "System.State": this.statuses.todo,
        "System.WorkItemType": "User Story",
        "System.AssignedTo": FAKE_IDENTITY,
        "System.CreatedBy": FAKE_IDENTITY,
        "System.CreatedDate": timestamp,
        "System.ChangedDate": timestamp,
        "System.Tags": serializeTags(input.labels ?? []),
      },
      comments: [],
    };
    this.workItems.set(workItem.id, workItem);
    return { key: String(workItem.id), url: this.editUrl(workItem.id) };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const workItem = this.requireWorkItem(ticketKey);
    const id = this.nextCommentId++;
    const timestamp = this.timestamp();
    workItem.comments.push({
      id,
      text: markdownToHtml(body),
      createdBy: FAKE_IDENTITY,
      createdDate: timestamp,
      modifiedDate: timestamp,
    });
    workItem.fields["System.ChangedDate"] = timestamp;
    return String(id);
  }

  /** Close a scenario-owned work item by moving it to its terminal state. */
  async closeTicket(ticketKey: string): Promise<void> {
    const workItem = this.requireWorkItem(ticketKey);
    workItem.fields["System.State"] = this.statuses.done;
    workItem.fields["System.ChangedDate"] = this.timestamp();
  }

  async deleteComment(commentId: string): Promise<void> {
    const id = Number(commentId);
    for (const workItem of this.workItems.values()) {
      const index = workItem.comments.findIndex((comment) => comment.id === id);
      if (index >= 0) {
        workItem.comments.splice(index, 1);
        workItem.fields["System.ChangedDate"] = this.timestamp();
        return;
      }
    }
    throw new Error(`Fake Azure DevOps comment not found: ${commentId}`);
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const workItem = this.requireWorkItem(ticketKey);
    return {
      state: String(workItem.fields["System.State"] ?? ""),
      labels: parseTags(workItem.fields["System.Tags"]),
      body: htmlToPlainText(String(workItem.fields["System.Description"] ?? "")),
    };
  }

  /** Current `System.State`, which is what {@link TrackerTicketState.state} holds. */
  async getStatus(ticketKey: string): Promise<string> {
    return String(this.requireWorkItem(ticketKey).fields["System.State"] ?? "");
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    const workItem = this.requireWorkItem(ticketKey);
    return workItem.comments.map((comment) => ({
      id: String(comment.id),
      body: htmlToPlainText(comment.text),
    }));
  }

  /**
   * Run a WIQL query against the fake's own HTTP endpoint, so the provider
   * fixture exercises the same route the CLI's `--query` path uses.
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    const response = await fetch(
      `${this.baseUrl}/${encodeURIComponent(this.project)}/_apis/wit/wiql?api-version=7.0&$top=100`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`:${FAKE_PAT}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Fake Azure DevOps WIQL request failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { workItems?: Array<{ id: number }> };
    return (body.workItems ?? []).map((item) => ({
      key: String(item.id),
      url: this.editUrl(item.id),
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
    const orgPrefix = `/${this.organization}`;

    if (path !== orgPrefix && !path.startsWith(`${orgPrefix}/`)) {
      return this.unmatched(method, path);
    }
    const scopedPath = path.slice(orgPrefix.length);

    const wiqlMatch = scopedPath.match(/^\/([^/]+)\/_apis\/wit\/wiql$/i);
    if (wiqlMatch?.[1] && method === "POST") {
      return this.queryWorkItems(wiqlMatch[1], request);
    }

    if (method === "GET" && /^\/_apis\/wit\/workitems$/i.test(scopedPath)) {
      return this.getWorkItems(url);
    }

    const detailMatch = scopedPath.match(/^\/_apis\/wit\/workitems\/(\d+)$/i);
    if (detailMatch?.[1] && method === "GET") {
      return this.getWorkItem(Number(detailMatch[1]));
    }
    if (detailMatch?.[1] && method === "PATCH") {
      return this.patchWorkItem(Number(detailMatch[1]), request);
    }

    const commentsMatch = scopedPath.match(/^\/([^/]+)\/_apis\/wit\/workItems\/(\d+)\/comments$/i);
    if (commentsMatch?.[1] && commentsMatch[2]) {
      if (commentsMatch[1] !== this.project) return this.unmatched(method, path);
      if (method === "GET") {
        return this.getComments(Number(commentsMatch[2]));
      }
      if (method === "POST") {
        return this.postComment(Number(commentsMatch[2]), request);
      }
    }

    return this.unmatched(method, path);
  }

  private unmatched(method: string, path: string): Response {
    const diagnostic = `Unmatched fake Azure DevOps request: ${method} ${path}`;
    this.unexpectedRequests.push(diagnostic);
    return json({ message: diagnostic, typeKey: "UnmatchedRequestException" }, 404);
  }

  private async queryWorkItems(project: string, request: Request): Promise<Response> {
    if (project !== this.project) {
      return this.unmatched("POST", `/${this.organization}/${project}/_apis/wit/wiql`);
    }
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const query = asRecord(body.value)?.query;
    if (typeof query !== "string") {
      const diagnostic = "Fake Azure DevOps WIQL request is missing a string `query`";
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 400);
    }
    const { matches, error } = matchWorkItems(query, [...this.workItems.values()]);
    if (error) {
      this.unexpectedRequests.push(error);
      return json({ message: error }, 400);
    }
    return json({ workItems: matches.map((workItem) => ({ id: workItem.id })) });
  }

  private getWorkItems(url: URL): Response {
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length === 0) {
      const diagnostic = "Fake Azure DevOps batch work-items request is missing `ids`";
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 400);
    }
    return json({
      count: ids.length,
      value: ids
        .map((id) => this.workItems.get(id))
        .filter((workItem): workItem is FakeAzureDevOpsWorkItem => Boolean(workItem))
        .map((workItem) => ({
          id: workItem.id,
          fields: {
            "System.Id": workItem.id,
            "System.Title": workItem.fields["System.Title"],
            "System.ChangedDate": workItem.fields["System.ChangedDate"],
          },
        })),
    });
  }

  private getWorkItem(id: number): Response {
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    return json(this.workItemPayload(workItem));
  }

  private async patchWorkItem(id: number, request: Request): Promise<Response> {
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    if (!Array.isArray(body.value)) {
      const diagnostic = "Fake Azure DevOps work-item PATCH body must be a JSON patch array";
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 400);
    }
    for (const operation of body.value) {
      const record = asRecord(operation);
      const path = typeof record?.path === "string" ? record.path : "";
      const fieldPath = path.match(/^\/fields\/(.+)$/)?.[1];
      if (!fieldPath) {
        const diagnostic = `Unsupported fake Azure DevOps JSON patch path: ${path || "<missing>"}`;
        this.unexpectedRequests.push(diagnostic);
        return json({ message: diagnostic }, 400);
      }
      // JSON-patch paths escape `/` and `~` inside field names; Azure DevOps
      // field names contain neither, so decode defensively and reject the rest.
      const field = fieldPath.replace(/~1/g, "/").replace(/~0/g, "~");
      workItem.fields[field] = record?.value;
    }
    workItem.fields["System.ChangedDate"] = this.timestamp();
    return json(this.workItemPayload(workItem));
  }

  private getComments(id: number): Response {
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    return json({
      totalCount: workItem.comments.length,
      count: workItem.comments.length,
      comments: workItem.comments.map((comment) => this.commentPayload(comment)),
    });
  }

  private async postComment(id: number, request: Request): Promise<Response> {
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const text = asRecord(body.value)?.text;
    if (typeof text !== "string") {
      const diagnostic = "Fake Azure DevOps comment body is missing a string `text`";
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 400);
    }
    const timestamp = this.timestamp();
    const comment: FakeAzureDevOpsComment = {
      id: this.nextCommentId++,
      text,
      createdBy: FAKE_IDENTITY,
      createdDate: timestamp,
      modifiedDate: timestamp,
    };
    workItem.comments.push(comment);
    workItem.fields["System.ChangedDate"] = timestamp;
    return json(this.commentPayload(comment), 201);
  }

  private workItemPayload(workItem: FakeAzureDevOpsWorkItem): Record<string, unknown> {
    return {
      id: workItem.id,
      rev: 1,
      fields: { ...workItem.fields },
      relations: [],
      _links: { html: { href: this.editUrl(workItem.id) } },
      url: `${this.baseUrl}/_apis/wit/workItems/${workItem.id}`,
    };
  }

  private commentPayload(comment: FakeAzureDevOpsComment): Record<string, unknown> {
    return {
      id: comment.id,
      text: comment.text,
      createdBy: comment.createdBy,
      createdDate: comment.createdDate,
      modifiedDate: comment.modifiedDate,
    };
  }

  private requireWorkItem(ticketKey: string): FakeAzureDevOpsWorkItem {
    const id = Number(ticketKey);
    const workItem = Number.isInteger(id) ? this.workItems.get(id) : undefined;
    if (!workItem) throw new Error(`Fake Azure DevOps work item not found: ${ticketKey}`);
    return workItem;
  }

  private editUrl(id: number): string {
    return `https://dev.azure.com/${this.organization}/${encodeURIComponent(this.project)}/_workitems/edit/${id}`;
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

function workItemNotFound(id: number): Response {
  return json(
    {
      message: `Fake Azure DevOps work item not found: ${id}`,
      typeKey: "WorkItemNotFoundException",
    },
    404,
  );
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: json({ message: "Invalid JSON request body" }, 400) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
