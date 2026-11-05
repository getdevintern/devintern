/**
 * In-process Asana REST API v1.0 fake.
 *
 * The fake implements only the endpoints the built Code CLI calls for a task
 * lifecycle. It is deliberately independent of the product Asana client: the
 * server parses raw HTTP requests and the fixture reads its own in-memory
 * state, so a client regression (wrong path, payload, or field) fails instead
 * of being mirrored by shared code.
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

const FAKE_ACCOUNT = { name: "E2E Asana User" } as const;

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

  private readonly apiToken = crypto.randomUUID();
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly baseUrl: string;
  private readonly tasks = new Map<string, FakeAsanaTask>();
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
  }

  async deleteComment(commentId: string): Promise<void> {
    for (const task of this.tasks.values()) {
      const index = task.stories.findIndex((story) => story.gid === commentId);
      if (index >= 0) {
        task.stories.splice(index, 1);
        task.modified_at = this.timestamp();
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
   * Search project tasks through the fake's own HTTP endpoint, using the same
   * filter semantics `AsanaClient.searchTasks` applies client-side.
   */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    const filters = parseFakeAsanaQuery(query);
    const projectGid = filters.projectGid ?? this.projectGidValue;
    const params = new URLSearchParams({ opt_fields: "gid,name", limit: "100" });
    if (filters.completed !== undefined) params.set("completed", String(filters.completed));
    if (filters.sectionName) params.set("section", filters.sectionName);
    if (filters.assignee) params.set("assignee", filters.assignee);
    if (filters.text) params.set("text", filters.text);

    const response = await fetch(
      `${this.baseUrl}${API_PREFIX}/projects/${projectGid}/tasks?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Fake Asana search failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as { data: Array<{ gid: string }> };
    return payload.data.map((task) => ({
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

    if (method === "GET" && path === `${API_PREFIX}/attachments`) {
      const parent = url.searchParams.get("parent");
      if (parent && !this.tasks.has(parent)) {
        return this.diagnostic(`Unknown fake Asana task: ${parent}`);
      }
      return json({ data: [] });
    }

    const projectTasksMatch = path.match(/^\/api\/1\.0\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch?.[1] && method === "GET") {
      return this.listProjectTasks(projectTasksMatch[1], url);
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
      return this.getTask(taskMatch[1]);
    }
    if (taskMatch?.[1] && method === "PUT") {
      return this.updateTask(taskMatch[1], request);
    }

    const storyMatch = path.match(/^\/api\/1\.0\/stories\/([^/]+)$/);
    if (storyMatch?.[1] && method === "PUT") {
      return this.updateStory(storyMatch[1], request);
    }

    return this.diagnostic(`Unmatched fake Asana request: ${method} ${path}`);
  }

  private listProjectTasks(projectGid: string, url: URL): Response {
    if (projectGid !== this.projectGidValue) {
      return this.diagnostic(`Unknown fake Asana project: ${projectGid}`);
    }
    const filters: FakeAsanaFilters = {
      sectionName: url.searchParams.get("section") ?? undefined,
      assignee: url.searchParams.get("assignee") ?? undefined,
      completed: parseBoolean(url.searchParams.get("completed")),
      text: url.searchParams.get("text") ?? undefined,
    };
    const tasks = [...this.tasks.values()].filter((task) => this.matchesFilters(task, filters));
    return json({ data: tasks.map((task) => this.taskPayload(task)) });
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
    task.section_gid = sectionGid;
    task.modified_at = this.timestamp();
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

  private getTask(taskGid: string): Response {
    const task = this.tasks.get(taskGid);
    if (!task) return this.diagnostic(`Unknown fake Asana task: ${taskGid}`);
    return json({ data: this.taskPayload(task) });
  }

  private async updateTask(taskGid: string, request: Request): Promise<Response> {
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
    return json({ data: this.taskPayload(task) });
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
    return story;
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

  private taskPayload(task: FakeAsanaTask): Record<string, unknown> {
    return {
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
    };
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

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value.toLowerCase() === "true";
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
