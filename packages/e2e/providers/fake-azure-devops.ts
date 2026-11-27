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
 * The server binds `127.0.0.1:0`, accepts any Basic-auth credentials unless
 * `pat` is set, never logs or echoes them, and never makes outbound requests.
 */

import { basicPatAuthorization, rejectWrongPat } from "./fake-auth";
import { markdownToHtml } from "./fake-azure-devops-html";
import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";
import {
  RELATION_NAMES,
  workItemTypeStates,
  workItemTypeStatesProject,
} from "./fake-azure-devops-links";
import type {
  FakeAzureDevOpsBlockerRequest,
  FakeAzureDevOpsRelation,
} from "./fake-azure-devops-links";

export type { FakeAzureDevOpsBlockerRequest } from "./fake-azure-devops-links";

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
  /** Work-item links, returned only under `$expand=relations` / `$expand=all`. */
  relations: FakeAzureDevOpsRelation[];
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
  /**
   * Stamp `System.CreatedDate`/`System.ChangedDate` from the wall clock
   * (strictly increasing) instead of the deterministic 2026-01-01 clock.
   *
   * Worker polling needs this: the product's change detector asks WIQL for
   * `[System.ChangedDate] >= '<today UTC>'`, so fixture timestamps must fall
   * on the real calendar day for a change to be visible.
   */
  realClock?: boolean;
  /** Caller-chosen PAT; any other `Authorization` than `Basic base64(":PAT")` gets 401. */
  pat?: string;
}

/** One WIQL request the fake received, with the ids it returned. */
export interface FakeAzureDevOpsWiqlRequest {
  /** Raw WIQL text from the request body. */
  query: string;
  /** Matched work-item ids; empty when the query was rejected. */
  ids: number[];
  /** Fake-side receive time (epoch ms). */
  at: number;
}

const FAKE_IDENTITY = { displayName: "E2E Azure DevOps User" } as const;
const FAKE_PAT = "fake-azure-devops-pat";

/** Field reference name the product writes when no custom field is configured. */
export const AZURE_DEVOPS_STORY_POINTS_FIELD = "Microsoft.VSTS.Scheduling.StoryPoints";

/**
 * Work-item comments are a preview API in Azure DevOps: requests without a
 * `-preview` `api-version` are rejected by the real service, so the fake
 * rejects them too (e.g. `7.1-preview.3` passes, `7.0` does not).
 */
const COMMENTS_API_VERSION_PATTERN = /^\d+\.\d+-preview(?:\.\d+)?$/;

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

/** Date fields that accept the ordering operators (`>=`, `>`, `<=`, `<`). */
const DATE_FIELDS = new Set(["system.createddate", "system.changeddate"]);

const DAY_LITERAL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Compare a stored ISO timestamp against a WIQL date literal.
 *
 * A `YYYY-MM-DD` literal is day-precision, as in real WIQL: the stored value is
 * reduced to its UTC calendar day before comparing. (Azure DevOps resolves the
 * day in the user's time zone; the fake fixes it to UTC, which is the zone the
 * product's change detector formats its literal in.) A full timestamp literal
 * compares instants. Returns undefined when either side is not a date.
 */
function compareDate(actual: string, literal: string): number | undefined {
  const actualMs = Date.parse(actual);
  if (!Number.isFinite(actualMs)) return undefined;
  if (DAY_LITERAL.test(literal)) {
    if (!Number.isFinite(Date.parse(`${literal}T00:00:00.000Z`))) return undefined;
    const actualDay = new Date(actualMs).toISOString().slice(0, 10);
    return actualDay < literal ? -1 : actualDay > literal ? 1 : 0;
  }
  const literalMs = Date.parse(literal);
  if (!Number.isFinite(literalMs)) return undefined;
  return Math.sign(actualMs - literalMs);
}

/**
 * Evaluate the WIQL subset the offline scenario uses.
 *
 * Supported: a `WHERE` containing `AND`-joined `[Field] OP 'value'` clauses
 * with `=`, `<>`, `CONTAINS`, or `NOT CONTAINS`, plus `>=`, `>`, `<=`, `<` on
 * `System.CreatedDate`/`System.ChangedDate` (see {@link compareDate}). Text
 * values are compared case-insensitively over the stored text. A query with a
 * `WHERE` the fake cannot parse returns no rows instead of every row, so a
 * selector regression cannot pass by matching the decoy.
 */
function matchWorkItems(
  query: string,
  workItems: FakeAzureDevOpsWorkItem[],
): { matches: FakeAzureDevOpsWorkItem[]; error?: string } {
  const whereIndex = query.search(/\bWHERE\b/i);
  if (whereIndex === -1) return { matches: workItems };

  const whereClause = query.slice(whereIndex + "WHERE".length);
  const clausePattern =
    /\[([^\]]+)\]\s*(<>|!=|>=|<=|=|>|<|CONTAINS\s+WORDS|CONTAINS|NOT\s+CONTAINS)\s*'([^']*)'/gi;
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

  // Ordering operators are only meaningful on date fields, and only with a
  // literal the fake can parse as a date.
  for (const clause of clauses) {
    if (![">=", ">", "<=", "<"].includes(clause.operator)) continue;
    if (!DATE_FIELDS.has(clause.field) || !Number.isFinite(Date.parse(clause.value))) {
      return { matches: [], error: `Unsupported fake Azure DevOps WIQL: ${query}` };
    }
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
        case ">=":
        case ">":
        case "<=":
        case "<": {
          const order = compareDate(actual, clause.value);
          if (order === undefined) return false;
          if (clause.operator === ">=") return order >= 0;
          if (clause.operator === ">") return order > 0;
          if (clause.operator === "<=") return order <= 0;
          return order < 0;
        }
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

  /** Requests answered with a bare 401 because the PAT was wrong or missing. */
  unauthorizedRequests = 0;

  /** Every WIQL request received, in arrival order (CLI, worker, and fixture). */
  readonly wiqlRequests: FakeAzureDevOpsWiqlRequest[] = [];

  /** Every relations / predecessor-batch read, in arrival order. */
  readonly blockerRequests: FakeAzureDevOpsBlockerRequest[] = [];

  /** Work items whose `$expand=relations` read answers HTTP 500. */
  private readonly failingRelationReads = new Set<number>();
  /** Work items an `errorPolicy=omit` batch read returns as `null`. */
  private readonly unreadableWorkItems = new Set<number>();

  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly workItems = new Map<number, FakeAzureDevOpsWorkItem>();
  private nextWorkItemId = 100;
  private nextCommentId = 10_000;
  private now = Date.parse("2026-01-01T00:00:00.000Z");
  private readonly realClock: boolean;
  private readonly pat: string | undefined;

  constructor(options: FakeAzureDevOpsOptions = {}) {
    this.organization = options.organization ?? "fakeorg";
    this.project = options.project ?? "FixtureProject";
    this.statuses = { ...FAKE_AZURE_DEVOPS_STATUSES, ...options.statuses };
    this.openState = this.statuses.todo;
    this.realClock = options.realClock ?? false;
    this.pat = options.pat;

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        rejectWrongPat(request, this.pat, () => this.unauthorizedRequests++) ??
        this.handle(request),
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
      AZURE_DEVOPS_PAT: this.pat ?? FAKE_PAT,
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
      relations: [],
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

  /**
   * Move a work item to another workflow state, as a human would in the board.
   *
   * Bumps `System.ChangedDate`, so the worker sees a fresh `(key, updated)`
   * stamp on its next evaluate.
   */
  async setState(ticketKey: string, state: string): Promise<void> {
    const workItem = this.requireWorkItem(ticketKey);
    workItem.fields["System.State"] = state;
    workItem.fields["System.ChangedDate"] = this.timestamp();
  }

  /**
   * Add a work-item link from `ticketKey` to `targetKey`, as the board's
   * "Add link" does. The predecessor link of a successor is
   * `System.LinkTypes.Dependency-Reverse`. Does not bump `System.ChangedDate`,
   * so seeding links before the worker starts leaves no extra change.
   *
   * @param ticketKey - Work item that owns the link
   * @param rel - Link type reference name (`System.LinkTypes.*`)
   * @param targetKey - Linked work item
   */
  addRelation(ticketKey: string, rel: string, targetKey: string): void {
    const workItem = this.requireWorkItem(ticketKey);
    const target = this.requireWorkItem(targetKey);
    workItem.relations.push({
      rel,
      url: `${this.baseUrl}/_apis/wit/workItems/${target.id}`,
      attributes: { isLocked: false, name: RELATION_NAMES[rel] ?? rel },
    });
  }

  /**
   * Make the `$expand=relations` read of one work item answer HTTP 500 (or
   * recover with `false`). Other reads of the item are unaffected.
   */
  failRelationReads(ticketKey: string, fail = true): void {
    const id = this.requireWorkItem(ticketKey).id;
    if (fail) this.failingRelationReads.add(id);
    else this.failingRelationReads.delete(id);
  }

  /**
   * Treat a work item as deleted or unreadable for `errorPolicy=omit` batch
   * reads: the real service returns a `null` entry in `value` for it.
   */
  setUnreadable(ticketKey: string, unreadable = true): void {
    const id = this.requireWorkItem(ticketKey).id;
    if (unreadable) this.unreadableWorkItems.add(id);
    else this.unreadableWorkItems.delete(id);
  }

  /** Relations reads of one work item (`$expand=relations`), in arrival order. */
  relationReads(ticketKey: string): FakeAzureDevOpsBlockerRequest[] {
    const id = Number(ticketKey);
    return this.blockerRequests.filter(
      (request) => request.kind === "relations" && request.ids[0] === id,
    );
  }

  /**
   * Move the deterministic fake clock so a work item can be created "now" for
   * the estimation <24h skip. Later timestamped writes continue from here.
   *
   * @param epochMs - Epoch milliseconds to use as the server's current time
   */
  setNow(epochMs: number): void {
    if (!Number.isFinite(epochMs)) {
      throw new Error(`Invalid fake Azure DevOps clock: ${epochMs}`);
    }
    this.now = epochMs;
  }

  /** Read one stored work-item field, or `undefined` when it was never written. */
  getField(ticketKey: string, field: string): unknown {
    return this.requireWorkItem(ticketKey).fields[field];
  }

  /** Story points written through the work-item JSON patch (default field). */
  getStoryPoints(ticketKey: string, field = AZURE_DEVOPS_STORY_POINTS_FIELD): unknown {
    return this.getField(ticketKey, field);
  }

  /**
   * Stored comments with their raw HTML `text` and timestamps, so a test can
   * assert the product posted HTML (not markdown) and edited in place.
   */
  rawComments(ticketKey: string): Array<{
    id: string;
    text: string;
    createdDate: string;
    modifiedDate: string;
  }> {
    return this.requireWorkItem(ticketKey).comments.map((comment) => ({
      id: String(comment.id),
      text: comment.text,
      createdDate: comment.createdDate,
      modifiedDate: comment.modifiedDate,
    }));
  }

  /** Current `System.ChangedDate` (the `updated` stamp the worker dedupes on). */
  changedDate(ticketKey: string): string {
    return String(this.requireWorkItem(ticketKey).fields["System.ChangedDate"] ?? "");
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
          Authorization: basicPatAuthorization(this.pat ?? FAKE_PAT),
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

    const statesProject = workItemTypeStatesProject(method, scopedPath);
    if (statesProject !== undefined) {
      if (statesProject !== this.project) return this.unmatched(method, path);
      this.blockerRequests.push({ kind: "states", ids: [], status: 200, at: Date.now() });
      return json(workItemTypeStates(this.statuses));
    }

    const detailMatch = scopedPath.match(/^\/_apis\/wit\/workitems\/(\d+)$/i);
    if (detailMatch?.[1] && method === "GET") {
      return this.getWorkItem(Number(detailMatch[1]), url);
    }
    if (detailMatch?.[1] && method === "PATCH") {
      return this.patchWorkItem(Number(detailMatch[1]), request);
    }

    const commentsMatch = scopedPath.match(/^\/([^/]+)\/_apis\/wit\/workItems\/(\d+)\/comments$/i);
    if (commentsMatch?.[1] && commentsMatch[2]) {
      if (commentsMatch[1] !== this.project) return this.unmatched(method, path);
      const versionError = this.checkCommentsApiVersion(method, path, url);
      if (versionError) return versionError;
      if (method === "GET") {
        return this.getComments(Number(commentsMatch[2]));
      }
      if (method === "POST") {
        return this.postComment(Number(commentsMatch[2]), request);
      }
    }

    const commentMatch = scopedPath.match(
      /^\/([^/]+)\/_apis\/wit\/workItems\/(\d+)\/comments\/(\d+)$/i,
    );
    if (commentMatch?.[1] && commentMatch[2] && commentMatch[3] && method === "PATCH") {
      if (commentMatch[1] !== this.project) return this.unmatched(method, path);
      const versionError = this.checkCommentsApiVersion(method, path, url);
      if (versionError) return versionError;
      return this.updateComment(Number(commentMatch[2]), Number(commentMatch[3]), request);
    }

    return this.unmatched(method, path);
  }

  private unmatched(method: string, path: string): Response {
    const diagnostic = `Unmatched fake Azure DevOps request: ${method} ${path}`;
    this.unexpectedRequests.push(diagnostic);
    return json({ message: diagnostic, typeKey: "UnmatchedRequestException" }, 404);
  }

  /** Reject a comments request whose `api-version` is not a preview version. */
  private checkCommentsApiVersion(method: string, path: string, url: URL): Response | undefined {
    const version = url.searchParams.get("api-version") ?? "";
    if (COMMENTS_API_VERSION_PATTERN.test(version)) return undefined;
    const diagnostic = `Fake Azure DevOps comments API requires a preview api-version: ${method} ${path}?api-version=${version || "<missing>"}`;
    this.unexpectedRequests.push(diagnostic);
    return json({ message: diagnostic, typeKey: "VssInvalidPreviewVersionException" }, 400);
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
    this.wiqlRequests.push({
      query,
      ids: matches.map((workItem) => workItem.id),
      at: Date.now(),
    });
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
    // Like the real service, return only the requested `fields` (the WIQL
    // change detector asks for Id, Title, and ChangedDate; the predecessor
    // read in `AzureDevOpsClient.listPredecessors` for State, WorkItemType,
    // and TeamProject).
    const requested = (
      url.searchParams.get("fields") ?? "System.Id,System.Title,System.ChangedDate"
    )
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    const project = (workItem: FakeAzureDevOpsWorkItem) => ({
      id: workItem.id,
      fields: Object.fromEntries(
        requested.map((field) => [field, this.batchFieldValue(workItem, field)]),
      ),
    });
    // `errorPolicy=omit` answers a deleted or unreadable id with a `null`
    // entry in place, instead of failing the whole batch.
    const omit = (url.searchParams.get("errorPolicy") ?? "").toLowerCase() === "omit";
    if (omit) {
      const value = ids.map((id) => {
        const workItem = this.workItems.get(id);
        return workItem && !this.unreadableWorkItems.has(id) ? project(workItem) : null;
      });
      this.blockerRequests.push({ kind: "batch", ids, status: 200, at: Date.now() });
      return json({ count: value.length, value });
    }
    return json({
      count: ids.length,
      value: ids
        .map((id) => this.workItems.get(id))
        .filter((workItem): workItem is FakeAzureDevOpsWorkItem => Boolean(workItem))
        .map(project),
    });
  }

  private batchFieldValue(workItem: FakeAzureDevOpsWorkItem, field: string): unknown {
    if (field === "System.Id") return workItem.id;
    if (field === "System.TeamProject") return this.project;
    return workItem.fields[field];
  }

  private getWorkItem(id: number, url: URL): Response {
    const expand = (url.searchParams.get("$expand") ?? "").toLowerCase();
    const withRelations = expand === "relations" || expand === "all";
    if (expand === "relations") {
      const failing = this.failingRelationReads.has(id);
      this.blockerRequests.push({
        kind: "relations",
        ids: [id],
        status: failing ? 500 : this.workItems.has(id) ? 200 : 404,
        at: Date.now(),
      });
      if (failing) {
        return json(
          { message: "Fake Azure DevOps injected relations failure", typeKey: "InternalError" },
          500,
        );
      }
    }
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    return json(this.workItemPayload(workItem, withRelations));
  }

  private async patchWorkItem(id: number, request: Request): Promise<Response> {
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json-patch+json")) {
      // The real service answers 415 for a work-item update that is not a
      // JSON patch document.
      const diagnostic = `Fake Azure DevOps work-item PATCH requires application/json-patch+json, got ${contentType || "<missing>"}`;
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 415);
    }
    if (!Array.isArray(body.value)) {
      const diagnostic = "Fake Azure DevOps work-item PATCH body must be a JSON patch array";
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 400);
    }
    for (const operation of body.value) {
      const record = asRecord(operation);
      const op = typeof record?.op === "string" ? record.op : "";
      if (!["add", "replace"].includes(op)) {
        const diagnostic = `Unsupported fake Azure DevOps JSON patch op: ${op || "<missing>"}`;
        this.unexpectedRequests.push(diagnostic);
        return json({ message: diagnostic }, 400);
      }
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
    return json(this.workItemPayload(workItem, false));
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

  /**
   * Edit a comment in place, as the comments preview API does: the id and
   * `createdDate` stay, `text` and `modifiedDate` change. Like a new comment,
   * the edit bumps the work item's `System.ChangedDate`.
   */
  private async updateComment(id: number, commentId: number, request: Request): Promise<Response> {
    const workItem = this.workItems.get(id);
    if (!workItem) return workItemNotFound(id);
    const comment = workItem.comments.find((candidate) => candidate.id === commentId);
    if (!comment) {
      const diagnostic = `Fake Azure DevOps comment ${commentId} not found on work item ${id}`;
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic, typeKey: "CommentNotFoundException" }, 404);
    }
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const record = asRecord(body.value);
    const text = record?.text;
    if (typeof text !== "string" || Object.keys(record ?? {}).some((key) => key !== "text")) {
      const diagnostic = "Fake Azure DevOps comment update body must be exactly { text: string }";
      this.unexpectedRequests.push(diagnostic);
      return json({ message: diagnostic }, 400);
    }
    const timestamp = this.timestamp();
    comment.text = text;
    comment.modifiedDate = timestamp;
    workItem.fields["System.ChangedDate"] = timestamp;
    return json(this.commentPayload(comment));
  }

  /** Work-item body; `relations` is present only when expanded, as in the real API. */
  private workItemPayload(
    workItem: FakeAzureDevOpsWorkItem,
    withRelations: boolean,
  ): Record<string, unknown> {
    return {
      id: workItem.id,
      rev: 1,
      fields: { ...workItem.fields },
      ...(withRelations
        ? { relations: workItem.relations.map((relation) => ({ ...relation })) }
        : {}),
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
    if (this.realClock) {
      // Strictly increasing so every mutation yields a distinct stamp.
      this.now = Math.max(Date.now(), this.now + 1);
      return new Date(this.now).toISOString();
    }
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
