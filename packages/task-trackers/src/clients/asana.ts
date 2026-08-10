import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { markdownToAsanaHtmlNotes } from "@devintern/text-formatter";
import { mimeTypeFromFilename } from "./mime.ts";

/**
 * Asana REST API client
 *
 * API docs:
 * - Tasks: https://developers.asana.com/reference/createtask
 *   - Create task: POST /tasks
 *   - Get task: GET /tasks/:task_gid
 *   - Update task: PUT /tasks/:task_gid
 *   - Create subtask: POST /tasks/:parent_gid/subtasks
 * - Rich text: https://developers.asana.com/docs/rich-text (use html_notes, not notes)
 * - Projects: https://developers.asana.com/reference/getprojects
 *   - Get projects: GET /projects
 * - Add to project: POST /tasks/:task_gid/addProject
 * - Tags: https://developers.asana.com/reference/gettagsforworkspace
 *   - List workspace tags: GET /workspaces/:workspace_gid/tags
 *   - Add tag to task: POST /tasks/:task_gid/addTag
 */

export interface AsanaProject {
  gid: string;
  name: string;
}

/** Compact Asana tag (workspace catalog / task membership). */
export interface AsanaTag {
  gid: string;
  name: string;
}

export interface AsanaTask {
  gid: string;
  name: string;
  permalink_url: string;
}

export interface AsanaSection {
  gid: string;
  name: string;
}

export interface AsanaCustomField {
  gid: string;
  name: string;
  type?: string;
  number_value?: number | null;
}

export interface AsanaTaskDetail extends AsanaTask {
  /** Plain-text notes. */
  notes?: string;
  /** Rich-text HTML notes. */
  html_notes?: string;
  completed?: boolean;
  assignee?: { name?: string } | null;
  created_by?: { name?: string } | null;
  created_at?: string;
  modified_at?: string;
  tags?: Array<{ gid?: string; name: string }>;
  memberships?: Array<{
    project?: { gid: string; name?: string };
    section?: { gid: string; name?: string };
  }>;
  custom_fields?: AsanaCustomField[];
}

export interface AsanaStory {
  gid: string;
  /** Story subtype; comments are `comment_added`. */
  resource_subtype?: string;
  text?: string;
  html_text?: string;
  created_by?: { name?: string } | null;
  created_at: string;
}

export interface AsanaAttachment {
  gid: string;
  name?: string;
  download_url?: string | null;
}

/** Fields requested for detailed task reads. */
const TASK_DETAIL_FIELDS =
  "name,notes,html_notes,completed,permalink_url,assignee.name,created_at,modified_at,created_by.name,tags.gid,tags.name,memberships.project.gid,memberships.project.name,memberships.section.gid,memberships.section.name,custom_fields.gid,custom_fields.name,custom_fields.type,custom_fields.number_value";

/** Parsed filters for {@link AsanaClient.searchTasks} mini-syntax. */
export interface AsanaEvent {
  action: string;
  resource?: {
    gid: string;
    resource_type?: string;
  };
  created_at?: string;
}

export interface AsanaTaskFilters {
  projectGid?: string;
  sectionName?: string;
  assignee?: string;
  completed?: boolean;
  text?: string;
}

/**
 * Parse the `--query` mini-syntax used for Asana batch selection, e.g.
 * `project:12345 section:"To Do" assignee:me completed:false login bug`.
 * Remaining free text matches against task names (case-insensitive).
 */
export function parseAsanaTaskFilters(query: string): AsanaTaskFilters {
  const filters: AsanaTaskFilters = {};
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
    switch (key?.toLowerCase()) {
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

export class AsanaClient {
  private apiToken: string;
  private baseUrl = "https://app.asana.com/api/1.0";

  /**
   * Create an Asana REST API client.
   *
   * @param config - Personal access token.
   */
  constructor(config: { apiToken: string }) {
    this.apiToken = config.apiToken;
  }

  /**
   * Detect Asana `xml_parsing_error` responses from rich-text HTML notes.
   *
   * @param error - Caught error from a failed request.
   * @returns `true` when the error indicates invalid HTML notes.
   */
  private isXmlParsingError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("xml_parsing_error");
  }

  /**
   * Send an authenticated request to the Asana REST API.
   *
   * @param endpoint - API path including leading slash.
   * @param method - HTTP method (default `GET`).
   * @param body - Optional JSON body wrapper (`{ data: ... }` added by callers).
   * @returns Unwrapped `data` field from the response.
   * @throws When the response status is not OK.
   */
  private async request<T>(
    endpoint: string,
    method: string = "GET",
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: "application/json",
    };

    const options: RequestInit = { method, headers };

    if (body && method !== "GET") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Asana API error (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as { data: T };
    return json.data;
  }

  /**
   * Authenticated GET that preserves Asana pagination (`next_page.offset`).
   *
   * @param endpoint - API path including leading slash and query string.
   * @returns Unwrapped `data` plus optional next-page offset token.
   * @throws When the response status is not OK.
   */
  private async requestPage<T>(
    endpoint: string,
  ): Promise<{ data: T; nextOffset: string | undefined }> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Asana API error (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      data: T;
      next_page?: { offset?: string } | null;
    };
    return { data: json.data, nextOffset: json.next_page?.offset };
  }

  /**
   * Register a webhook on a resource (project) targeting a URL.
   *
   * Asana performs its `X-Hook-Secret` handshake against the target during
   * this call; the target must echo the header for creation to succeed.
   *
   * @param resourceGid - Project (or other resource) GID to watch.
   * @param targetUrl - Webhook target URL (e.g. a relay ingest URL).
   * @returns The created webhook GID.
   * @throws When the Asana API request or handshake fails.
   */
  async createWebhook(resourceGid: string, targetUrl: string): Promise<{ gid: string }> {
    const data = await this.request<{ gid: string }>("/webhooks", "POST", {
      data: { resource: resourceGid, target: targetUrl },
    });
    return { gid: data.gid };
  }

  /**
   * List projects accessible to the token.
   *
   * @returns Project GID and name records.
   * @throws When the Asana API request fails.
   */
  async getProjects(): Promise<AsanaProject[]> {
    return this.request<AsanaProject[]>("/projects");
  }

  /**
   * Resolve the workspace GID for a project, or the first accessible workspace.
   *
   * @param projectGid - Optional project GID whose workspace should be used.
   * @returns Workspace GID.
   * @throws When no workspace can be resolved.
   */
  async resolveWorkspaceGid(projectGid?: string): Promise<string> {
    if (projectGid) {
      const project = await this.request<{ workspace?: { gid?: string } }>(
        `/projects/${projectGid}?opt_fields=workspace.gid`,
      );
      const workspaceGid = project.workspace?.gid;
      if (workspaceGid) return workspaceGid;
    }

    const workspaces = await this.request<Array<{ gid: string }>>("/workspaces");
    const first = workspaces[0]?.gid;
    if (!first) {
      throw new Error("No Asana workspaces available for the current token");
    }
    return first;
  }

  /**
   * List tags in a workspace (paginated, soft-capped).
   *
   * @param workspaceGid - Workspace GID.
   * @param maxLabels - Soft catalog cap (default 500).
   * @returns Tag gid/name pairs plus truncation flag.
   * @throws When the Asana API request fails.
   */
  async getTags(
    workspaceGid: string,
    maxLabels: number = 500,
  ): Promise<{ tags: AsanaTag[]; truncated: boolean }> {
    const tags: AsanaTag[] = [];
    const pageSize = 100;
    let offset: string | undefined;
    let truncated = false;

    while (tags.length < maxLabels) {
      const limit = Math.min(pageSize, maxLabels - tags.length);
      const params = new URLSearchParams({
        limit: String(limit),
        opt_fields: "gid,name",
      });
      if (offset) params.set("offset", offset);

      const page = await this.requestPage<AsanaTag[]>(
        `/workspaces/${workspaceGid}/tags?${params.toString()}`,
      );
      tags.push(...page.data);

      if (!page.nextOffset) {
        break;
      }
      offset = page.nextOffset;
      if (tags.length >= maxLabels) {
        truncated = true;
        break;
      }
    }

    return {
      tags: tags.slice(0, maxLabels),
      truncated: truncated || tags.length > maxLabels,
    };
  }

  /**
   * Add an existing tag to a task.
   *
   * @param taskGid - Task GID.
   * @param tagGid - Tag GID from {@link getTags}.
   * @throws When the Asana API request fails.
   */
  async addTagToTask(taskGid: string, tagGid: string): Promise<void> {
    await this.request(`/tasks/${taskGid}/addTag`, "POST", {
      data: { tag: tagGid },
    });
  }

  /**
   * Fetch a task by GID.
   *
   * @param taskGid - Asana task GID.
   * @returns Task name and permalink URL.
   * @throws When the task is not found or the API request fails.
   */
  async getTask(taskGid: string): Promise<AsanaTask> {
    return this.request<AsanaTask>(`/tasks/${taskGid}`);
  }

  /**
   * Create a task with HTML notes, falling back to plain `notes` on XML parse errors.
   *
   * @param name - Task title.
   * @param description - Markdown body converted to Asana HTML.
   * @param projectGid - Optional project GID to add the task to.
   * @returns Created task GID and permalink URL.
   * @throws When both HTML and plain-text creation fail.
   */
  async createTask(name: string, description: string, projectGid?: string): Promise<AsanaTask> {
    const data: Record<string, unknown> = { name };

    if (projectGid) {
      data.projects = [projectGid];
    }

    try {
      return await this.request<AsanaTask>("/tasks", "POST", {
        data: { ...data, html_notes: markdownToAsanaHtmlNotes(description) },
      });
    } catch (error) {
      if (!this.isXmlParsingError(error)) {
        throw error;
      }
      return await this.request<AsanaTask>("/tasks", "POST", {
        data: { ...data, notes: description },
      });
    }
  }

  /**
   * Create a subtask under a parent, with HTML notes fallback.
   *
   * @param parentGid - Parent task GID.
   * @param name - Subtask title.
   * @param description - Optional markdown body.
   * @returns Created subtask GID and permalink URL.
   * @throws When creation fails after fallback attempts.
   */
  async createSubtask(parentGid: string, name: string, description?: string): Promise<AsanaTask> {
    const data: Record<string, unknown> = { name };

    if (!description) {
      return this.request<AsanaTask>(`/tasks/${parentGid}/subtasks`, "POST", { data });
    }

    try {
      return await this.request<AsanaTask>(`/tasks/${parentGid}/subtasks`, "POST", {
        data: { ...data, html_notes: markdownToAsanaHtmlNotes(description) },
      });
    } catch (error) {
      if (!this.isXmlParsingError(error)) {
        throw error;
      }
      return await this.request<AsanaTask>(`/tasks/${parentGid}/subtasks`, "POST", {
        data: { ...data, notes: description },
      });
    }
  }

  /**
   * Set a task's parent (for epic linking).
   *
   * @param taskGid - Child task GID.
   * @param parentGid - Parent task GID.
   * @returns Updated task record.
   * @throws When the Asana API request fails.
   */
  async setParent(taskGid: string, parentGid: string): Promise<AsanaTask> {
    return this.request<AsanaTask>(`/tasks/${taskGid}`, "PUT", {
      data: {
        parent: parentGid,
      },
    });
  }

  /**
   * Add an existing task to a project.
   *
   * @param taskGid - Task GID to add.
   * @param projectGid - Target project GID.
   * @throws When the Asana API request fails.
   */
  async addTaskToProject(taskGid: string, projectGid: string): Promise<void> {
    await this.request(`/tasks/${taskGid}/addProject`, "POST", {
      data: {
        project: projectGid,
      },
    });
  }

  /**
   * Fetch a task with detailed fields (notes, memberships, custom fields).
   *
   * Kept separate from the lightweight {@link getTask} used by
   * `@devintern/pm` so existing callers keep their minimal shape.
   *
   * @param taskGid - Asana task GID.
   * @throws When the task is not found or the API request fails.
   */
  async getTaskDetail(taskGid: string): Promise<AsanaTaskDetail> {
    return this.request<AsanaTaskDetail>(`/tasks/${taskGid}?opt_fields=${TASK_DETAIL_FIELDS}`);
  }

  /**
   * List comment stories on a task (oldest first).
   *
   * @param taskGid - Asana task GID.
   * @returns Stories with `resource_subtype === "comment_added"`.
   * @throws When the Asana API request fails.
   */
  async getStories(taskGid: string): Promise<AsanaStory[]> {
    const stories = await this.request<AsanaStory[]>(
      `/tasks/${taskGid}/stories?opt_fields=resource_subtype,text,html_text,created_by.name,created_at`,
    );
    return stories
      .filter((s) => s.resource_subtype === "comment_added")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Post a comment story with HTML rich text, falling back to plain text.
   *
   * @param taskGid - Asana task GID.
   * @param markdown - Comment body (markdown).
   * @returns Created story GID.
   * @throws When both HTML and plain-text creation fail.
   */
  async createStory(taskGid: string, markdown: string): Promise<string> {
    try {
      const story = await this.request<AsanaStory>(`/tasks/${taskGid}/stories`, "POST", {
        data: { html_text: markdownToAsanaHtmlNotes(markdown) },
      });
      return story.gid;
    } catch (error) {
      if (!this.isXmlParsingError(error)) {
        throw error;
      }
      const story = await this.request<AsanaStory>(`/tasks/${taskGid}/stories`, "POST", {
        data: { text: markdown },
      });
      return story.gid;
    }
  }

  /**
   * Update an existing comment story, with plain-text fallback.
   *
   * @param storyGid - Story GID to update.
   * @param markdown - New comment body (markdown).
   * @throws When both HTML and plain-text updates fail.
   */
  async updateStory(storyGid: string, markdown: string): Promise<void> {
    try {
      await this.request(`/stories/${storyGid}`, "PUT", {
        data: { html_text: markdownToAsanaHtmlNotes(markdown) },
      });
    } catch (error) {
      if (!this.isXmlParsingError(error)) {
        throw error;
      }
      await this.request(`/stories/${storyGid}`, "PUT", {
        data: { text: markdown },
      });
    }
  }

  /**
   * List sections in a project.
   *
   * @param projectGid - Project GID.
   * @throws When the Asana API request fails.
   */
  async getSections(projectGid: string): Promise<AsanaSection[]> {
    return this.request<AsanaSection[]>(`/projects/${projectGid}/sections`);
  }

  /**
   * Move a task into a section.
   *
   * @param sectionGid - Target section GID.
   * @param taskGid - Task GID to move.
   * @throws When the Asana API request fails.
   */
  async moveTaskToSection(sectionGid: string, taskGid: string): Promise<void> {
    await this.request(`/sections/${sectionGid}/addTask`, "POST", {
      data: { task: taskGid },
    });
  }

  /**
   * Mark a task complete or incomplete.
   *
   * @param taskGid - Task GID.
   * @param completed - Completion state.
   * @throws When the Asana API request fails.
   */
  async setCompleted(taskGid: string, completed: boolean): Promise<void> {
    await this.request(`/tasks/${taskGid}`, "PUT", {
      data: { completed },
    });
  }

  /**
   * List attachments on a task.
   *
   * @param taskGid - Task GID.
   * @throws When the Asana API request fails.
   */
  async getAttachments(taskGid: string): Promise<AsanaAttachment[]> {
    return this.request<AsanaAttachment[]>(
      `/attachments?parent=${taskGid}&opt_fields=name,download_url`,
    );
  }

  /**
   * Upload a local file as an attachment on an Asana task.
   *
   * @param taskGid - Parent task GID.
   * @param filePath - Absolute path to the local file.
   * @param options - Optional filename / MIME overrides.
   * @throws When the Asana API request fails.
   */
  async uploadAttachment(
    taskGid: string,
    filePath: string,
    options?: { filename?: string; mimeType?: string },
  ): Promise<void> {
    const filename = options?.filename || basename(filePath);
    const mimeType = options?.mimeType || mimeTypeFromFilename(filename);
    const bytes = new Uint8Array(readFileSync(filePath));
    const form = new FormData();
    form.append("parent", taskGid);
    form.append("file", new Blob([bytes], { type: mimeType }), filename);

    const response = await fetch(`${this.baseUrl}/attachments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Asana attachment upload failed (${response.status}): ${errorText}`);
    }
  }

  /**
   * Set a custom field value on a task.
   *
   * @param taskGid - Task GID.
   * @param fieldGid - Custom field GID.
   * @param value - New field value.
   * @throws When the Asana API request fails (e.g. field not on the task).
   */
  async updateCustomField(taskGid: string, fieldGid: string, value: unknown): Promise<void> {
    await this.request(`/tasks/${taskGid}`, "PUT", {
      data: { custom_fields: { [fieldGid]: value } },
    });
  }

  /**
   * List tasks in a project with basic filters, client-side filtered.
   *
   * Uses project task listing instead of the workspace search endpoint,
   * which is limited to Asana Premium plans. Results are capped at 100
   * tasks per page (only the first page is fetched).
   *
   * @param filters - Parsed filters (see {@link parseAsanaTaskFilters}).
   * @returns Matching tasks and total count of returned tasks.
   * @throws When no project GID is available or the API request fails.
   */
  async searchTasks(
    filters: AsanaTaskFilters,
  ): Promise<{ tasks: AsanaTaskDetail[]; total: number }> {
    if (!filters.projectGid) {
      throw new Error(
        "Asana task search requires a project. Pass project:<gid> in the query or set ASANA_DEFAULT_PROJECT_GID.",
      );
    }

    const tasks = await this.request<AsanaTaskDetail[]>(
      `/projects/${filters.projectGid}/tasks?opt_fields=${TASK_DETAIL_FIELDS}&limit=100`,
    );

    const matches = tasks.filter((task) => {
      if (filters.completed !== undefined && (task.completed ?? false) !== filters.completed) {
        return false;
      }
      if (filters.sectionName) {
        const inSection = (task.memberships || []).some(
          (m) => m.section?.name?.toLowerCase() === filters.sectionName!.toLowerCase(),
        );
        if (!inSection) return false;
      }
      if (filters.assignee && filters.assignee !== "me") {
        const name = task.assignee?.name?.toLowerCase() || "";
        if (!name.includes(filters.assignee.toLowerCase())) return false;
      }
      if (filters.text) {
        if (!task.name.toLowerCase().includes(filters.text.toLowerCase())) return false;
      }
      return true;
    });

    return { tasks: matches, total: matches.length };
  }

  /**
   * Fetch change events for a resource via the Events API (purpose-built for
   * polling).
   *
   * Asana's Events API is sync-token based: the first call (no token) and any
   * call with an expired token return HTTP 412 with a fresh token and no
   * events — reported here as `fullSync: true`, meaning the gap since the
   * last token is unknown and callers should treat everything as changed.
   *
   * @param resourceGid - Project (or task) GID to watch.
   * @param syncToken - Token from the previous call, if any.
   * @returns Events since the token, the next token, and the full-sync flag.
   * @throws When the API request fails with a status other than 412.
   */
  async getEvents(
    resourceGid: string,
    syncToken?: string,
  ): Promise<{ events: AsanaEvent[]; sync: string; fullSync: boolean }> {
    const url = new URL(`${this.baseUrl}/events`);
    url.searchParams.set("resource", resourceGid);
    if (syncToken) {
      url.searchParams.set("sync", syncToken);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
    });

    // 412 Precondition Failed carries the fresh sync token in its body.
    if (response.status === 412) {
      const json = (await response.json()) as { sync?: string };
      return { events: [], sync: json.sync ?? "", fullSync: true };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Asana API error (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as { data?: AsanaEvent[]; sync?: string };
    return { events: json.data ?? [], sync: json.sync ?? "", fullSync: false };
  }
}
