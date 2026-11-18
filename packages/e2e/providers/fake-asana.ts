/**
 * In-process Asana REST API v1.0 fake.
 *
 * The fake implements only the endpoints the built Code CLI calls for a task
 * lifecycle. It is deliberately independent of the product Asana client: the
 * server parses raw HTTP requests and the fixture reads its own in-memory
 * state, so a client regression (wrong path, payload, or field) fails instead
 * of being mirrored by shared code.
 *
 * Task responses honor the request's `opt_fields`, as real Asana does. A client
 * that stops asking for a field the scenario depends on (for example
 * `memberships.section.name` for section selection) therefore loses that field
 * and fails here rather than being masked by an unconditional full payload.
 *
 * Routing is strict. Any request the fake does not implement returns a 404
 * whose body names the method and path, and the request is recorded so a test
 * can fail loudly even if the product ignores the error response.
 *
 * The server binds `127.0.0.1:0`, accepts any Bearer token, never logs or
 * echoes it, and never makes outbound requests.
 */

import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

/** Task statuses are project sections in Asana. */
export interface FakeAsanaStatuses {
  todo: string;
  inProgress: string;
  pr: string;
  done: string;
}

/** Distinct section names used by the fake by default. */
export const FAKE_ASANA_STATUSES: FakeAsanaStatuses = {
  todo: "To Do",
  inProgress: "In Progress",
  pr: "In Review",
  done: "Done",
};

export interface FakeAsanaOptions {
  /** Project GID whose task list the CLI searches. */
  projectGid?: string;
  /** Project name exposed on task memberships. */
  projectName?: string;
  /** Override one or more section names. */
  statuses?: Partial<FakeAsanaStatuses>;
}

/** Filters the product applies after listing a project's tasks. */
interface FakeAsanaFilters {
  projectGid?: string;
  sectionName?: string;
  assignee?: string;
  completed?: boolean;
  text?: string;
}

interface FakeAsanaStory {
  gid: string;
  text: string;
  html_text: string;
  created_at: string;
}

interface FakeAsanaTag {
  gid: string;
  name: string;
}

interface FakeAsanaCustomField {
  gid: string;
  name: string;
  type: string;
  number_value?: number | null;
}

interface FakeAsanaTask {
  gid: string;
  name: string;
  notes: string;
  html_notes: string;
  completed: boolean;
  permalink_url: string;
  created_at: string;
  modified_at: string;
  assignee: { name: string } | null;
  created_by: { name: string } | null;
  tags: FakeAsanaTag[];
  custom_fields: FakeAsanaCustomField[];
  project_gid: string;
  section_gid: string;
  stories: FakeAsanaStory[];
}

/**
 * One Events API record, in Asana's documented compact shape.
 *
 * `resource` is the object that changed (a task or a story), `parent` is the
 * task a story belongs to, and `change` names the field for `changed` events.
 */
export interface FakeAsanaEvent {
  type: "task" | "story";
  action: "added" | "changed" | "removed";
  resource: { gid: string; resource_type: "task" | "story" };
  parent: { gid: string; resource_type: "task" | "section" } | null;
  user: { gid: string; resource_type: "user" };
  created_at: string;
  change?: { field: string; action: "changed" | "added" | "removed" };
}

/**
 * One `GET /events` call the fake served.
 *
 * Sync tokens are opaque Asana cursors, not credentials, so the received and
 * issued values are recorded verbatim for the test's chain assertions. The
 * Bearer token is only checked, never stored.
 */
export interface FakeAsanaSyncRequest {
  /** `resource` query parameter. */
  resource: string | null;
  /** `sync` query parameter, or null when the client sent none. */
  received: string | null;
  /** 412 for a missing/unknown/expired token, 200 for a valid one. */
  status: 200 | 412;
  /** Events returned on a 200 page (always 0 for a 412). */
  eventCount: number;
  /** Fresh `sync` token the response carried. */
  issued: string;
  /** Whether the request's Bearer token matched the fake's issued token. */
  authorized: boolean;
}

/** Asana's 412 explanation, so a client that parses `errors` sees real text. */
const SYNC_TOKEN_INVALID_MESSAGE =
  "Sync token invalid or too old. If you are attempting to keep resources in sync, " +
  "you must fetch the full dataset for this query now and use the new sync token for the next sync.";

const FAKE_ACCOUNT = { name: "E2E Asana User" } as const;
const FAKE_USER_GID = "1100000000000001";

const API_PREFIX = "/api/1.0";

/** Escape text for the restricted HTML subset Asana rich text accepts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render plain text as Asana-style HTML notes. */
function textToHtml(text: string): string {
  return `<body>${escapeHtml(text).replace(/\n/g, "<br/>")}</body>`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Convert stored Asana `html_text` back to readable plain text.
 *
 * Headings keep their `#` prefixes so the implementation summary asserts on
 * the same literal `## What changed` heading the markdown formatter emitted.
 */
function htmlToPlainText(html: string): string {
  const structured = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, inner: string) => `\n${"#".repeat(Number(level))} ${inner}\n`,
    )
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(structured)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse the `--query` mini-syntax the fake's search endpoint supports. */
function parseFakeAsanaQuery(query: string): FakeAsanaFilters {
  const filters: FakeAsanaFilters = {};
  const remainder: string[] = [];
  const tokenRegex = /(\w+):(?:"([^"]*)"|(\S+))|(\S+)/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(query)) !== null) {
    const [, key, quoted, bare, free] = match;
    if (free !== undefined) {
      remainder.push(free);
      continue;
    }
    if (key === undefined) continue;
    const value = quoted ?? bare ?? "";
    switch (key.toLowerCase()) {
      case "project":
        filters.projectGid = value;
        break;
      case "section":
        filters.sectionName = value;
        break;
      case "assignee":
        filters.assignee = value;
        break;
      case "completed":
        filters.completed = value.toLowerCase() === "true";
        break;
      default:
        remainder.push(match[0]);
    }
  }

  if (remainder.length > 0) {
    filters.text = remainder.join(" ");
  }
  return filters;
}

/** Asana-shaped ticket fixture backed entirely by in-memory state. */
export class FakeAsanaTracker implements TrackerFixture {
  readonly type = "asana";
  readonly statusKind = "state" as const;
  readonly openState: string;
  readonly statuses: FakeAsanaStatuses;
  readonly projectGidValue: string;
  readonly projectName: string;

  /** Requests the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedRequests: string[] = [];

  /** Every request served, so a test can prove traffic never reached the fake. */
  readonly requests: string[] = [];

  private readonly apiToken = crypto.randomUUID();
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly baseUrl: string;
  /** Every `GET /events` call, oldest first. */
  readonly syncRequests: FakeAsanaSyncRequest[] = [];

  /** Every project task listing (the worker's evaluate step and `--query` runs). */
  readonly projectTaskListings: string[] = [];

  private readonly tasks = new Map<string, FakeAsanaTask>();
  /** Append-only Events API log for the watched project. */
  private readonly events: FakeAsanaEvent[] = [];
  /** Live sync tokens mapped to the event-log position they were issued at. */
  private readonly syncTokens = new Map<string, number>();
  private nextTaskGid = 1_200_000_000_000_100;
  private nextStoryGid = 1_400_000_000_000_000;
  private nextTagGid = 1_500_000_000_000_000;
  private now = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(options: FakeAsanaOptions = {}) {
    this.projectGidValue = options.projectGid ?? "1200000000000001";
    this.projectName = options.projectName ?? "E2E Asana Project";
    this.statuses = { ...FAKE_ASANA_STATUSES, ...options.statuses };
    this.openState = this.statuses.todo;

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  /** Base URL of the fake server (without the API prefix). */
  get url(): string {
    return this.baseUrl;
  }

  /** REST API base URL the CLI subprocess must use. */
  get apiBaseUrl(): string {
    return `${this.baseUrl}${API_PREFIX}`;
  }

  /** Tracker configuration/credentials for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      ASANA_API_TOKEN: this.apiToken,
      ASANA_DEFAULT_PROJECT_GID: this.projectGidValue,
      // The shared client only honors ASANA_API_BASE_URL behind this explicit
      // test flag, so a project .env cannot redirect a real PAT.
      DEVINTERN_E2E_FAKE_ASANA: "1",
      ASANA_API_BASE_URL: this.apiBaseUrl,
    };
  }

  /** Project GID `resolveProjectKey` derives from the task memberships. */
  projectKey(): string {
    return this.projectGidValue;
  }

  /** Asana tags are per-task in this fake; no workspace label creation exists. */
  async ensureLabels(_labels: string[]): Promise<void> {}

  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const gid = String(this.nextTaskGid++);
    const timestamp = this.timestamp();
    const task: FakeAsanaTask = {
      gid,
      name: input.title,
      notes: input.body,
      html_notes: textToHtml(input.body),
      completed: false,
      permalink_url: `${this.baseUrl}/0/${this.projectGidValue}/${gid}`,
      created_at: timestamp,
      modified_at: timestamp,
      assignee: null,
      created_by: { name: FAKE_ACCOUNT.name },
      tags: (input.labels ?? []).map((name) => ({ gid: String(this.nextTagGid++), name })),
      custom_fields: [],
      project_gid: this.projectGidValue,
      section_gid: this.sectionGid(this.statuses.todo),
      stories: [],
    };
    this.tasks.set(gid, task);
    this.recordEvent({ type: "task", action: "added", gid, parent: null });
    return { key: gid, url: task.permalink_url };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const task = this.requireTask(ticketKey);
    const story = this.addStory(task, body, textToHtml(body));
    return story.gid;
  }

  /** Close a scenario-owned task by marking it complete. */
  async closeTicket(ticketKey: string): Promise<void> {
    const task = this.requireTask(ticketKey);
    task.completed = true;
    task.modified_at = this.timestamp();
    this.recordEvent({ type: "task", action: "changed", gid: task.gid, field: "completed" });
  }

  /**
   * Edit a task as a human would in the Asana UI (rename and/or new notes).
   *
   * Bumps `modified_at` and appends a `changed` event, like a real edit.
   */
  editTicket(ticketKey: string, edit: { title?: string; body?: string }): void {
    const task = this.requireTask(ticketKey);
    if (edit.title !== undefined) {
      task.name = edit.title;
      this.recordEvent({ type: "task", action: "changed", gid: task.gid, field: "name" });
    }
    if (edit.body !== undefined) {
      task.notes = edit.body;
      task.html_notes = textToHtml(edit.body);
      this.recordEvent({ type: "task", action: "changed", gid: task.gid, field: "notes" });
    }
    task.modified_at = this.timestamp();
  }

  /** Raw `modified_at` stamp, which the product uses as the task's `updated`. */
  modifiedAt(ticketKey: string): string {
    return this.requireTask(ticketKey).modified_at;
  }

  /** Snapshot of the Events API log, oldest first. */
  eventLog(): FakeAsanaEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  /**
   * Invalidate every outstanding sync token, as Asana does once a token ages
   * out. The next `GET /events` with any previously issued token gets a 412.
   */
  expireSyncTokens(): void {
    this.syncTokens.clear();
  }

  async deleteComment(commentId: string): Promise<void> {
    for (const task of this.tasks.values()) {
      const index = task.stories.findIndex((story) => story.gid === commentId);
      if (index >= 0) {
        task.stories.splice(index, 1);
        task.modified_at = this.timestamp();
        this.recordEvent({ type: "story", action: "removed", gid: commentId, parent: task.gid });
        return;
      }
    }
    throw new Error(`Fake Asana story not found: ${commentId}`);
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const task = this.requireTask(ticketKey);
    return {
      state: task.completed ? "completed" : this.sectionName(task.section_gid),
      labels: task.tags.map((tag) => tag.name),
      body: task.notes,
    };
  }

  /** Current section name, which is Asana's workflow status. */
  async getStatus(ticketKey: string): Promise<string> {
    return this.sectionName(this.requireTask(ticketKey).section_gid);
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    const task = this.requireTask(ticketKey);
    return [...task.stories]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((story) => ({ id: story.gid, body: htmlToPlainText(story.html_text) }));
  }

  /**
   * Search project tasks through the fake's own HTTP endpoint, then apply the
   * same filter semantics `AsanaClient.searchTasks` applies client-side.
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    const filters = parseFakeAsanaQuery(query);
    const projectGid = filters.projectGid ?? this.projectGidValue;
    // Match the product request exactly: it lists the project's tasks and
    // filters locally rather than sending section/assignee/text query params,
    // which the real Asana API does not accept here.
    const params = new URLSearchParams({ opt_fields: "gid,name", limit: "100" });

    const response = await fetch(
      `${this.baseUrl}${API_PREFIX}/projects/${projectGid}/tasks?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Fake Asana search failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as { data: Array<{ gid: string }> };
    return payload.data
      .map((task) => this.tasks.get(task.gid))
      .filter((task): task is FakeAsanaTask => task !== undefined)
      .filter((task) => this.matchesFilters(task, filters))
      .map((task) => ({
        key: task.gid,
        url: `${this.baseUrl}/0/${projectGid}/${task.gid}`,
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
    this.requests.push(`${method} ${path}${url.search}`);

    const collection = method === "GET" ? this.handleCollection(path, url, request) : undefined;
    if (collection) return collection;

    const projectTasksMatch = path.match(/^\/api\/1\.0\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch?.[1] && method === "GET") {
      return this.listProjectTasks(
        projectTasksMatch[1],
        parseOptFields(url.searchParams.get("opt_fields")),
      );
    }

    const projectSectionsMatch = path.match(/^\/api\/1\.0\/projects\/([^/]+)\/sections$/);
    if (projectSectionsMatch?.[1] && method === "GET") {
      return this.listSections(projectSectionsMatch[1]);
    }

    const addTaskMatch = path.match(/^\/api\/1\.0\/sections\/([^/]+)\/addTask$/);
    if (addTaskMatch?.[1] && method === "POST") {
      return this.addTaskToSection(addTaskMatch[1], request);
    }

    const storiesMatch = path.match(/^\/api\/1\.0\/tasks\/([^/]+)\/stories$/);
    if (storiesMatch?.[1] && method === "GET") {
      return this.getStories(storiesMatch[1]);
    }
    if (storiesMatch?.[1] && method === "POST") {
      return this.postStory(storiesMatch[1], request);
    }

    const taskMatch = path.match(/^\/api\/1\.0\/tasks\/([^/]+)$/);
    if (taskMatch?.[1] && method === "GET") {
      return this.getTask(taskMatch[1], parseOptFields(url.searchParams.get("opt_fields")));
    }
    if (taskMatch?.[1] && method === "PUT") {
      return this.updateTask(
        taskMatch[1],
        request,
        parseOptFields(url.searchParams.get("opt_fields")),
      );
    }

    const storyMatch = path.match(/^\/api\/1\.0\/stories\/([^/]+)$/);
    if (storyMatch?.[1] && method === "PUT") {
      return this.updateStory(storyMatch[1], request);
    }

    return this.diagnostic(`Unmatched fake Asana request: ${method} ${path}`);
  }

  /**
   * GET collections: the Events API feed, task attachments, and task
   * dependencies.
   */
  private handleCollection(path: string, url: URL, request: Request): Response | undefined {
    // Fake tasks declare no dependencies ("waiting on"), so the worker's
    // tracker dependency gate always finds them unblocked.
    const dependenciesMatch = path.match(/^\/api\/1\.0\/tasks\/([^/]+)\/dependencies$/);
    if (dependenciesMatch?.[1]) {
      if (!this.tasks.has(dependenciesMatch[1])) {
        return this.diagnostic(`Unknown fake Asana task: ${dependenciesMatch[1]}`);
      }
      return json({ data: [] });
    }
    if (path === `${API_PREFIX}/events`) {
      return this.getEvents(url.searchParams, request.headers.get("authorization"));
    }
    if (path === `${API_PREFIX}/attachments`) {
      const parent = url.searchParams.get("parent");
      if (parent && !this.tasks.has(parent)) {
        return this.diagnostic(`Unknown fake Asana task: ${parent}`);
      }
      return json({ data: [] });
    }
    return undefined;
  }

  private listProjectTasks(projectGid: string, optFields: string[] | undefined): Response {
    if (projectGid !== this.projectGidValue) {
      return this.diagnostic(`Unknown fake Asana project: ${projectGid}`);
    }
    this.projectTaskListings.push(projectGid);
    // Real `GET /projects/{gid}/tasks` only supports pagination/field params.
    // The product lists the full project and filters client-side.
    return json({
      data: [...this.tasks.values()].map((task) => this.taskPayload(task, optFields)),
    });
  }

  private listSections(projectGid: string): Response {
    if (projectGid !== this.projectGidValue) {
      return this.diagnostic(`Unknown fake Asana project: ${projectGid}`);
    }
    return json({ data: this.allStatusNames().map((name) => this.sectionPayload(name)) });
  }

  private async addTaskToSection(sectionGid: string, request: Request): Promise<Response> {
    const sectionName = this.sectionNameOrUndefined(sectionGid);
    if (!sectionName) {
      return this.diagnostic(`Unknown fake Asana section: ${sectionGid}`);
    }
    const body = await readJson(request);
    if (!body.ok) return this.reject(body.message);
    const taskGid = asRecord(asRecord(body.value)?.data)?.task;
    if (typeof taskGid !== "string") {
      return this.reject("addTask requires data.task");
    }
    const task = this.tasks.get(taskGid);
    if (!task) {
      return this.diagnostic(`Unknown fake Asana task: ${taskGid}`);
    }
    const moved = task.section_gid !== sectionGid;
    task.section_gid = sectionGid;
    task.modified_at = this.timestamp();
    if (moved) {
      // Asana reports a section move as the task being added to the new section.
      this.recordEvent({ type: "task", action: "added", gid: task.gid, parent: sectionGid });
    }
    return json({ data: {} });
  }

  private getStories(taskGid: string): Response {
    const task = this.tasks.get(taskGid);
    if (!task) return this.diagnostic(`Unknown fake Asana task: ${taskGid}`);
    const stories = [...task.stories].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return json({ data: stories.map((story) => this.storyPayload(story)) });
  }

  private async postStory(taskGid: string, request: Request): Promise<Response> {
    const task = this.tasks.get(taskGid);
    if (!task) return this.diagnostic(`Unknown fake Asana task: ${taskGid}`);
    const body = await readJson(request);
    if (!body.ok) return this.reject(body.message);
    const data = asRecord(asRecord(body.value)?.data);
    if (!data) return this.reject("Story requires a data object");

    const htmlText = typeof data.html_text === "string" ? data.html_text : undefined;
    const plainText = typeof data.text === "string" ? data.text : undefined;
    if (htmlText === undefined && plainText === undefined) {
      return this.reject("Story requires html_text or text");
    }

    const story = this.addStory(
      task,
      plainText ?? htmlToPlainText(htmlText ?? ""),
      htmlText ?? textToHtml(plainText ?? ""),
    );
    return json({ data: this.storyPayload(story) }, 201);
  }

  private getTask(taskGid: string, optFields: string[] | undefined): Response {
    const task = this.tasks.get(taskGid);
    if (!task) return this.diagnostic(`Unknown fake Asana task: ${taskGid}`);
    return json({ data: this.taskPayload(task, optFields) });
  }

  private async updateTask(
    taskGid: string,
    request: Request,
    optFields: string[] | undefined,
  ): Promise<Response> {
    const task = this.tasks.get(taskGid);
    if (!task) return this.diagnostic(`Unknown fake Asana task: ${taskGid}`);
    const body = await readJson(request);
    if (!body.ok) return this.reject(body.message);
    const data = asRecord(asRecord(body.value)?.data);
    if (!data) return this.reject("Task update requires a data object");

    if (typeof data.completed === "boolean") {
      task.completed = data.completed;
    }
    if (typeof data.name === "string") {
      task.name = data.name;
    }
    if (typeof data.notes === "string") {
      task.notes = data.notes;
    }
    if (typeof data.html_notes === "string") {
      task.html_notes = data.html_notes;
    }
    const customFields = asRecord(data.custom_fields);
    if (customFields) {
      for (const [fieldGid, value] of Object.entries(customFields)) {
        const existing = task.custom_fields.find((field) => field.gid === fieldGid);
        const numberValue = typeof value === "number" ? value : null;
        if (existing) {
          existing.number_value = numberValue;
        } else {
          task.custom_fields.push({
            gid: fieldGid,
            name: fieldGid,
            type: "number",
            number_value: numberValue,
          });
        }
      }
    }
    task.modified_at = this.timestamp();
    for (const field of Object.keys(data)) {
      this.recordEvent({ type: "task", action: "changed", gid: task.gid, field });
    }
    return json({ data: this.taskPayload(task, optFields) });
  }

  private async updateStory(storyGid: string, request: Request): Promise<Response> {
    const story = this.findStory(storyGid);
    if (!story) return this.diagnostic(`Unknown fake Asana story: ${storyGid}`);
    const body = await readJson(request);
    if (!body.ok) return this.reject(body.message);
    const data = asRecord(asRecord(body.value)?.data);
    if (!data) return this.reject("Story update requires a data object");

    const htmlText = typeof data.html_text === "string" ? data.html_text : undefined;
    const plainText = typeof data.text === "string" ? data.text : undefined;
    if (htmlText === undefined && plainText === undefined) {
      return this.reject("Story update requires html_text or text");
    }
    story.html_text = htmlText ?? textToHtml(plainText ?? "");
    story.text = plainText ?? htmlToPlainText(htmlText ?? "");
    this.recordEvent({
      type: "story",
      action: "changed",
      gid: story.gid,
      parent: this.storyParent(story.gid),
      field: "text",
    });
    return json({ data: this.storyPayload(story) });
  }

  private addStory(task: FakeAsanaTask, text: string, htmlText: string): FakeAsanaStory {
    const story: FakeAsanaStory = {
      gid: String(this.nextStoryGid++),
      text,
      html_text: htmlText,
      created_at: this.timestamp(),
    };
    task.stories.push(story);
    task.modified_at = story.created_at;
    this.recordEvent({ type: "story", action: "added", gid: story.gid, parent: task.gid });
    return story;
  }

  private storyParent(storyGid: string): string | null {
    for (const task of this.tasks.values()) {
      if (task.stories.some((story) => story.gid === storyGid)) return task.gid;
    }
    return null;
  }

  /**
   * `GET /events?resource=<project>&sync=<token>`, with Asana's sync semantics.
   *
   * A missing, unknown, or expired token returns 412 with a fresh `sync` and
   * Asana's `errors` array; a live token returns every event recorded since it
   * was issued plus a rotated `sync`. Old tokens stay valid until
   * {@link expireSyncTokens}, as real Asana tokens do until they age out.
   */
  private getEvents(params: URLSearchParams, authorization: string | null): Response {
    const resource = params.get("resource");
    const received = params.get("sync");
    const authorized = authorization === `Bearer ${this.apiToken}`;
    if (resource !== this.projectGidValue) {
      return this.diagnostic(`Unknown fake Asana events resource: ${resource ?? "(missing)"}`, 400);
    }

    const issued = this.issueSyncToken();
    const position = received === null ? undefined : this.syncTokens.get(received);
    if (position === undefined) {
      this.syncRequests.push({
        resource,
        received,
        status: 412,
        eventCount: 0,
        issued,
        authorized,
      });
      return json({ sync: issued, errors: [{ message: SYNC_TOKEN_INVALID_MESSAGE }] }, 412);
    }

    const page = this.events.slice(position);
    this.syncRequests.push({
      resource,
      received,
      status: 200,
      eventCount: page.length,
      issued,
      authorized,
    });
    return json({ data: page, sync: issued, has_more: false });
  }

  private issueSyncToken(): string {
    const token = crypto.randomUUID().replace(/-/g, "");
    this.syncTokens.set(token, this.events.length);
    return token;
  }

  private recordEvent(input: {
    type: FakeAsanaEvent["type"];
    action: FakeAsanaEvent["action"];
    gid: string;
    parent?: string | null;
    field?: string;
  }): void {
    const parentType = input.type === "story" ? "task" : "section";
    this.events.push({
      type: input.type,
      action: input.action,
      resource: { gid: input.gid, resource_type: input.type },
      parent: input.parent ? { gid: input.parent, resource_type: parentType } : null,
      user: { gid: FAKE_USER_GID, resource_type: "user" },
      created_at: new Date(this.now).toISOString(),
      ...(input.field ? { change: { field: input.field, action: "changed" as const } } : {}),
    });
  }

  private findStory(storyGid: string): FakeAsanaStory | undefined {
    for (const task of this.tasks.values()) {
      const story = task.stories.find((candidate) => candidate.gid === storyGid);
      if (story) return story;
    }
    return undefined;
  }

  private matchesFilters(task: FakeAsanaTask, filters: FakeAsanaFilters): boolean {
    if (filters.completed !== undefined && task.completed !== filters.completed) {
      return false;
    }
    if (filters.sectionName) {
      const section = this.sectionName(task.section_gid).toLowerCase();
      if (section !== filters.sectionName.toLowerCase()) return false;
    }
    if (filters.assignee && filters.assignee !== "me") {
      const name = task.assignee?.name?.toLowerCase() ?? "";
      if (!name.includes(filters.assignee.toLowerCase())) return false;
    }
    if (filters.text && !task.name.toLowerCase().includes(filters.text.toLowerCase())) {
      return false;
    }
    return true;
  }

  private taskPayload(
    task: FakeAsanaTask,
    optFields: string[] | undefined,
  ): Record<string, unknown> {
    return projectTaskPayload(
      {
        gid: task.gid,
        name: task.name,
        notes: task.notes,
        html_notes: task.html_notes,
        completed: task.completed,
        permalink_url: task.permalink_url,
        created_at: task.created_at,
        modified_at: task.modified_at,
        assignee: task.assignee,
        created_by: task.created_by,
        tags: task.tags.map((tag) => ({ gid: tag.gid, name: tag.name })),
        custom_fields: task.custom_fields.map((field) => ({
          gid: field.gid,
          name: field.name,
          type: field.type,
          number_value: field.number_value ?? null,
        })),
        memberships: [
          {
            project: { gid: task.project_gid, name: this.projectName },
            section: {
              gid: task.section_gid,
              name: this.sectionName(task.section_gid),
            },
          },
        ],
      },
      optFields,
    );
  }

  private storyPayload(story: FakeAsanaStory): Record<string, unknown> {
    return {
      gid: story.gid,
      resource_subtype: "comment_added",
      type: "story",
      text: story.text,
      html_text: story.html_text,
      created_by: { name: FAKE_ACCOUNT.name },
      created_at: story.created_at,
    };
  }

  private sectionPayload(name: string): Record<string, unknown> {
    return { gid: this.sectionGid(name), name };
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

  private sectionGid(name: string): string {
    const index = this.allStatusNames().indexOf(name);
    return String(1_300_000_000_000_000 + Math.max(index, 0));
  }

  private sectionName(sectionGid: string): string {
    return this.sectionNameOrUndefined(sectionGid) ?? this.statuses.todo;
  }

  private sectionNameOrUndefined(sectionGid: string): string | undefined {
    return this.allStatusNames().find((name) => this.sectionGid(name) === sectionGid);
  }

  private requireTask(ticketKey: string): FakeAsanaTask {
    const task = this.tasks.get(ticketKey);
    if (!task) throw new Error(`Fake Asana task not found: ${ticketKey}`);
    return task;
  }

  private diagnostic(message: string, status = 404): Response {
    this.unexpectedRequests.push(message);
    return json({ errors: [{ message }] }, status);
  }

  private reject(message: string): Response {
    return this.diagnostic(message, 400);
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

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, message: "Invalid JSON request body" };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Fields Asana returns even when `opt_fields` does not name them. */
const ALWAYS_RETURNED_TASK_FIELDS = ["gid"] as const;

/** Task fields in Asana's compact representation, used without `opt_fields`. */
const COMPACT_TASK_FIELDS = ["gid", "name"] as const;

/** Nested tree of requested field names. */
type FieldSelection = Map<string, FieldSelection>;

/** Parse a comma-separated `opt_fields` selector. */
function parseOptFields(raw: string | null): string[] | undefined {
  const fields = raw
    ?.split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  return fields && fields.length > 0 ? fields : undefined;
}

/** Build a field tree from dotted selectors such as `memberships.section.name`. */
function buildFieldSelection(fields: readonly string[]): FieldSelection {
  const selection: FieldSelection = new Map();
  for (const field of fields) {
    let node = selection;
    for (const segment of field.split(".")) {
      let child = node.get(segment);
      if (!child) {
        child = new Map();
        node.set(segment, child);
      }
      node = child;
    }
  }
  return selection;
}

/** Keep only selected fields, recursing into nested objects and arrays. */
function selectFields(value: unknown, selection: FieldSelection): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => selectFields(entry, selection));
  if (typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const [field, children] of selection) {
    if (!(field in record)) continue;
    selected[field] = children.size === 0 ? record[field] : selectFields(record[field], children);
  }
  return selected;
}

/**
 * Project a full task payload onto the request's `opt_fields`.
 *
 * Real Asana always returns `gid` and otherwise includes only the requested
 * fields; omitting the selector returns the compact task. Keeping that behavior
 * means a client that drops a required field from its `opt_fields` loses the
 * field here instead of passing against an unrealistically complete payload.
 */
function projectTaskPayload(
  payload: Record<string, unknown>,
  optFields: string[] | undefined,
): Record<string, unknown> {
  const selection = buildFieldSelection(optFields ?? COMPACT_TASK_FIELDS);
  for (const field of ALWAYS_RETURNED_TASK_FIELDS) {
    selection.set(field, new Map());
  }
  return selectFields(payload, selection) as Record<string, unknown>;
}
