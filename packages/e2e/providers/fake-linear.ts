/**
 * In-process Linear GraphQL fake.
 *
 * The fake implements only the operations the built Code CLI calls for a task
 * lifecycle. It is deliberately independent of the product `LinearClient`: the
 * server parses raw HTTP/GraphQL text and owns its own in-memory state, so a
 * client regression (wrong operation, variables, or field) fails instead of
 * being mirrored by shared code.
 *
 * Routing is strict. Any operation the fake does not recognize, or any
 * malformed payload, returns a diagnostic GraphQL error and is recorded in
 * {@link FakeLinearTracker.unexpectedOperations} so a test can assert the
 * collection is empty even if the product ignores the error response.
 *
 * The server binds `127.0.0.1:0`, accepts any `Authorization` header (never
 * reading or logging it), and never makes outbound requests.
 */

import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

interface FakeLinearLabel {
  id: string;
  name: string;
}

interface FakeLinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { name: string };
}

interface FakeLinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  /** Issue body in markdown. */
  description: string;
  stateId: string;
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  labels: FakeLinearLabel[];
  createdAt: string;
  updatedAt: string;
  comments: FakeLinearComment[];
}

interface FakeLinearState {
  id: string;
  name: string;
  type: string;
}

/** Workflow states the fake exposes through its team state lookup. */
export interface FakeLinearStatuses {
  todo: string;
  inProgress: string;
  pr: string;
  done: string;
}

/** Distinct workflow states used by the fake by default. */
export const FAKE_LINEAR_STATUSES: FakeLinearStatuses = {
  todo: "Todo",
  inProgress: "In Progress",
  pr: "In Review",
  done: "Done",
};

export interface FakeLinearOptions {
  /** Linear team key; issue identifiers are `<teamKey>-<number>`. */
  teamKey?: string;
  /** Override one or more workflow state names. */
  statuses?: Partial<FakeLinearStatuses>;
}

const FAKE_TEAM_ID = "fake-team-eng";
const FAKE_USER_NAME = "E2E Linear User";

/** A predicate over fake issues, built from a Linear IssueFilter. */
type IssueMatcher = (issue: FakeLinearIssue) => boolean;

/** Linear GraphQL fake backed entirely by in-memory state. */
export class FakeLinearTracker implements TrackerFixture {
  readonly type = "linear";
  readonly statusKind = "state" as const;
  readonly openState: string;
  readonly statuses: FakeLinearStatuses;
  readonly teamKeyValue: string;
  readonly teamId = FAKE_TEAM_ID;

  /** Operations the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedOperations: string[] = [];

  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly baseUrl: string;
  private readonly states: FakeLinearState[];
  private readonly issues = new Map<string, FakeLinearIssue>();
  private nextIssueNumber = 1;
  private nextCommentId = 10_000;
  private now = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(options: FakeLinearOptions = {}) {
    this.teamKeyValue = options.teamKey ?? "ENG";
    this.statuses = { ...FAKE_LINEAR_STATUSES, ...options.statuses };
    this.openState = this.statuses.todo;
    this.states = this.buildStates();

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  /** GraphQL endpoint the CLI subprocess must use. */
  get url(): string {
    return `${this.baseUrl}/graphql`;
  }

  /** Tracker configuration/credentials for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      LINEAR_API_KEY: "fake-linear-api-key",
      LINEAR_API_URL: this.url,
    };
  }

  /** Team key `resolveProjectKey` derives from the issue identifier prefix. */
  projectKey(): string {
    return this.teamKeyValue;
  }

  /** Linear labels are issue fields; no team label creation is required. */
  async ensureLabels(_labels: string[]): Promise<void> {}

  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const identifier = `${this.teamKeyValue}-${this.nextIssueNumber++}`;
    const timestamp = this.timestamp();
    const issue: FakeLinearIssue = {
      id: `issue-${identifier.toLowerCase()}`,
      identifier,
      url: `${this.baseUrl}/issue/${identifier}`,
      title: input.title,
      description: input.body,
      stateId: this.stateId(this.statuses.todo),
      priority: 3,
      priorityLabel: "Medium",
      estimate: null,
      labels: (input.labels ?? []).map((name) => ({
        id: `label-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
    };
    this.issues.set(identifier.toUpperCase(), issue);
    return { key: identifier, url: issue.url };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const issue = this.requireIssue(ticketKey);
    const id = String(this.nextCommentId++);
    const timestamp = this.timestamp();
    issue.comments.push({
      id,
      body,
      createdAt: timestamp,
      updatedAt: timestamp,
      user: { name: FAKE_USER_NAME },
    });
    issue.updatedAt = timestamp;
    return id;
  }

  /** Resolve a scenario-owned issue by moving it to its terminal state. */
  async closeTicket(ticketKey: string): Promise<void> {
    const issue = this.requireIssue(ticketKey);
    issue.stateId = this.stateId(this.statuses.done);
    issue.updatedAt = this.timestamp();
  }

  async deleteComment(commentId: string): Promise<void> {
    for (const issue of this.issues.values()) {
      const index = issue.comments.findIndex((comment) => comment.id === commentId);
      if (index >= 0) {
        issue.comments.splice(index, 1);
        issue.updatedAt = this.timestamp();
        return;
      }
    }
    throw new Error(`Fake Linear comment not found: ${commentId}`);
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const issue = this.requireIssue(ticketKey);
    return {
      state: this.stateName(issue.stateId),
      labels: issue.labels.map((label) => label.name),
      body: issue.description,
    };
  }

  /** Current workflow state, which is what {@link TrackerTicketState.state} holds. */
  async getStatus(ticketKey: string): Promise<string> {
    return this.stateName(this.requireIssue(ticketKey).stateId);
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    return this.requireIssue(ticketKey).comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
    }));
  }

  /**
   * Evaluate the small IssueFilter subset the offline scenario uses.
   *
   * Accepts the JSON filter the production client sends (for example
   * `{"title":{"containsIgnoreCase":"<marker>"}}`) as well as a plain-text
   * title search, matching the client's own normalization.
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    const trimmed = query.trim();
    let filter: unknown = trimmed;
    if (trimmed.startsWith("{")) {
      try {
        filter = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(
          `Invalid fake Linear filter JSON: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    const matcher = compileIssueFilter(filter);
    if (!matcher) {
      throw new Error(`Unsupported fake Linear filter: ${query}`);
    }
    return [...this.issues.values()]
      .filter(matcher)
      .map((issue) => ({ key: issue.identifier, url: issue.url }));
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
    const method = request.method.toUpperCase();

    if (method !== "POST" || url.pathname !== "/graphql") {
      return this.unexpected(`Unmatched fake Linear request: ${method} ${url.pathname}`, 404);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return this.unexpected("Invalid JSON request body", 400);
    }

    const body = asRecord(payload);
    const query = typeof body?.query === "string" ? body.query : undefined;
    if (!query) {
      return this.unexpected("Missing GraphQL query string");
    }
    const variables = asRecord(body?.variables) ?? {};
    const operation = operationName(query);

    switch (operation) {
      case "IssueById":
        return this.issueById(variables);
      case "IssueComments":
        return this.issueComments(variables);
      case "TeamStates":
        return this.teamStates(variables);
      case "CommentCreate":
        return this.commentCreate(variables);
      case "IssueUpdate":
        return this.issueUpdate(variables);
      case "SearchIssues":
        return this.searchIssues(variables);
      default:
        return this.unexpected(`Unsupported GraphQL operation: ${operation ?? "<anonymous>"}`);
    }
  }

  private issueById(variables: Record<string, unknown>): Response {
    const id = variables.id;
    if (typeof id !== "string" || !id.trim()) {
      return this.unexpected("IssueById requires a non-empty string `id` variable");
    }
    const issue = this.findIssue(id);
    if (!issue) {
      return json({ data: { issue: null } });
    }
    return json({ data: { issue: this.issuePayload(issue) } });
  }

  private issueComments(variables: Record<string, unknown>): Response {
    const id = variables.id;
    if (typeof id !== "string" || !id.trim()) {
      return this.unexpected("IssueComments requires a non-empty string `id` variable");
    }
    const issue = this.findIssue(id);
    if (!issue) {
      return this.unexpected(`IssueComments: unknown issue id "${id}"`);
    }
    return json({
      data: {
        issue: {
          comments: {
            nodes: issue.comments.map((comment) => ({
              id: comment.id,
              body: comment.body,
              createdAt: comment.createdAt,
              updatedAt: comment.updatedAt,
              user: { name: comment.user.name },
            })),
          },
        },
      },
    });
  }

  private teamStates(variables: Record<string, unknown>): Response {
    if (variables.id !== this.teamId) {
      return this.unexpected(`TeamStates: unknown team id "${String(variables.id)}"`);
    }
    return json({
      data: {
        team: {
          states: {
            nodes: this.states.map((state) => ({
              id: state.id,
              name: state.name,
              type: state.type,
            })),
          },
        },
      },
    });
  }

  private commentCreate(variables: Record<string, unknown>): Response {
    const input = asRecord(variables.input);
    const issueId = input?.issueId;
    const text = input?.body;
    if (typeof issueId !== "string" || typeof text !== "string") {
      return this.unexpected("CommentCreate requires string `input.issueId` and `input.body`");
    }
    const issue = this.findIssue(issueId);
    if (!issue) {
      return this.unexpected(`CommentCreate: unknown issue id "${issueId}"`);
    }

    const id = String(this.nextCommentId++);
    const timestamp = this.timestamp();
    issue.comments.push({
      id,
      body: text,
      createdAt: timestamp,
      updatedAt: timestamp,
      user: { name: FAKE_USER_NAME },
    });
    issue.updatedAt = timestamp;
    return json({ data: { commentCreate: { success: true, comment: { id } } } });
  }

  private issueUpdate(variables: Record<string, unknown>): Response {
    const id = variables.id;
    const input = asRecord(variables.input);
    if (typeof id !== "string" || !input) {
      return this.unexpected("IssueUpdate requires string `id` and object `input`");
    }
    const issue = this.findIssue(id);
    if (!issue) {
      return this.unexpected(`IssueUpdate: unknown issue id "${id}"`);
    }

    const supported = new Set(["stateId", "estimate", "labelIds", "title", "description"]);
    for (const key of Object.keys(input)) {
      if (!supported.has(key)) {
        return this.unexpected(`IssueUpdate: unsupported input field "${key}"`);
      }
    }

    if (input.stateId !== undefined) {
      if (typeof input.stateId !== "string" || !this.stateNameOrUndefined(input.stateId)) {
        return this.unexpected(`IssueUpdate: unknown workflow state "${String(input.stateId)}"`);
      }
      issue.stateId = input.stateId;
    }
    if (input.estimate !== undefined) {
      if (typeof input.estimate !== "number") {
        return this.unexpected("IssueUpdate: `estimate` must be a number");
      }
      issue.estimate = input.estimate;
    }
    if (input.labelIds !== undefined) {
      if (!Array.isArray(input.labelIds)) {
        return this.unexpected("IssueUpdate: `labelIds` must be an array");
      }
      const names = new Map(issue.labels.map((label) => [label.id, label.name]));
      issue.labels = input.labelIds.map((labelId) => {
        const name = typeof labelId === "string" ? names.get(labelId) : undefined;
        return {
          id: typeof labelId === "string" ? labelId : "",
          name: name ?? (typeof labelId === "string" ? labelId : ""),
        };
      });
    }
    if (input.title !== undefined) {
      if (typeof input.title !== "string") {
        return this.unexpected("IssueUpdate: `title` must be a string");
      }
      issue.title = input.title;
    }
    if (input.description !== undefined) {
      if (typeof input.description !== "string") {
        return this.unexpected("IssueUpdate: `description` must be a string");
      }
      issue.description = input.description;
    }

    issue.updatedAt = this.timestamp();
    return json({ data: { issueUpdate: { success: true } } });
  }

  private searchIssues(variables: Record<string, unknown>): Response {
    const matcher = compileIssueFilter(variables.filter);
    if (!matcher) {
      return this.unexpected(
        `SearchIssues: unsupported filter ${JSON.stringify(variables.filter)}`,
      );
    }
    const matches = [...this.issues.values()].filter(matcher);
    return json({
      data: {
        issues: {
          nodes: matches.map((issue) => this.issuePayload(issue)),
        },
      },
    });
  }

  private issuePayload(issue: FakeLinearIssue): Record<string, unknown> {
    const state = this.states.find((candidate) => candidate.id === issue.stateId);
    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      estimate: issue.estimate,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      state: state
        ? { id: state.id, name: state.name, type: state.type }
        : { id: issue.stateId, name: issue.stateId, type: "unknown" },
      assignee: { name: "E2E Linear Assignee" },
      creator: { name: "E2E Linear Creator" },
      team: { id: this.teamId, key: this.teamKeyValue },
      labels: {
        nodes: issue.labels.map((label) => ({ id: label.id, name: label.name })),
      },
      attachments: { nodes: [] },
    };
  }

  private buildStates(): FakeLinearState[] {
    return [...new Set(Object.values(this.statuses))].map((name, index) => ({
      id: `state-${index + 1}`,
      name,
      type: this.stateType(name),
    }));
  }

  private stateType(name: string): string {
    if (name === this.statuses.todo) return "unstarted";
    if (name === this.statuses.done) return "completed";
    return "started";
  }

  private stateId(name: string): string {
    return this.states.find((state) => state.name === name)?.id ?? this.states[0]?.id ?? "";
  }

  private stateName(stateId: string): string {
    return this.states.find((state) => state.id === stateId)?.name ?? stateId;
  }

  private stateNameOrUndefined(stateId: string): string | undefined {
    return this.states.find((state) => state.id === stateId)?.name;
  }

  private findIssue(value: string): FakeLinearIssue | undefined {
    const byIdentifier = this.issues.get(value.toUpperCase());
    if (byIdentifier) return byIdentifier;
    for (const issue of this.issues.values()) {
      if (issue.id === value) return issue;
    }
    return undefined;
  }

  private requireIssue(ticketKey: string): FakeLinearIssue {
    const issue = this.findIssue(ticketKey);
    if (!issue) throw new Error(`Fake Linear issue not found: ${ticketKey}`);
    return issue;
  }

  private timestamp(): string {
    this.now += 1000;
    return new Date(this.now).toISOString();
  }

  private unexpected(message: string, status = 200): Response {
    this.unexpectedOperations.push(message);
    return json({ data: null, errors: [{ message }] }, status);
  }
}

/** Extract the operation name from a GraphQL document (query/mutation/subscription). */
function operationName(query: string): string | undefined {
  return query.match(/\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

/** Compile the Linear IssueFilter subset the fake supports into a predicate. */
function compileIssueFilter(value: unknown): IssueMatcher | undefined {
  if (typeof value === "string") {
    const needle = value.toLowerCase();
    return (issue) => issue.title.toLowerCase().includes(needle);
  }

  const filter = asRecord(value);
  if (!filter) return undefined;

  const matchers: IssueMatcher[] = [];
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "and" || key === "or") {
      if (!Array.isArray(condition)) return undefined;
      const children = condition.map(compileIssueFilter);
      if (children.some((child) => child === undefined)) return undefined;
      const compiled = children.filter((child): child is IssueMatcher => Boolean(child));
      matchers.push(
        key === "and"
          ? (issue) => compiled.every((matcher) => matcher(issue))
          : (issue) => compiled.some((matcher) => matcher(issue)),
      );
      continue;
    }
    if (key === "title" || key === "description") {
      const matcher = compileStringCondition(key, condition);
      if (!matcher) return undefined;
      matchers.push(matcher);
      continue;
    }
    return undefined;
  }

  return (issue) => matchers.every((matcher) => matcher(issue));
}

/** Compile a `{containsIgnoreCase|contains|eq|neq}` condition on one text field. */
function compileStringCondition(
  field: "title" | "description",
  condition: unknown,
): IssueMatcher | undefined {
  const operations = asRecord(condition);
  if (!operations) return undefined;

  const matchers: IssueMatcher[] = [];
  for (const [operation, rawValue] of Object.entries(operations)) {
    if (typeof rawValue !== "string") return undefined;
    switch (operation) {
      case "eq":
        matchers.push((issue) => issue[field] === rawValue);
        break;
      case "neq":
        matchers.push((issue) => issue[field] !== rawValue);
        break;
      case "contains":
        matchers.push((issue) => issue[field].includes(rawValue));
        break;
      case "containsIgnoreCase": {
        const needle = rawValue.toLowerCase();
        matchers.push((issue) => issue[field].toLowerCase().includes(needle));
        break;
      }
      default:
        return undefined;
    }
  }

  return (issue) => matchers.every((matcher) => matcher(issue));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
