/**
 * Azure DevOps REST API client
 *
 * API docs:
 * - Create work item: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create
 * - Update work item: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update
 * - Get projects: https://learn.microsoft.com/en-us/rest/api/azure/devops/core/projects/list
 * - Get work item types: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types/list
 * - List project tags: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/tags/list
 * - Description field format (HTML default, Markdown opt-in):
 *   https://devblogs.microsoft.com/devops/markdown-support-arrives-for-work-items/
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { markdownToHtmlDescription } from "@devintern/text-formatter";
import { mimeTypeFromFilename } from "./mime.ts";

export interface AzureDevOpsWorkItem {
  id: number;
  url: string;
}

export interface AzureDevOpsProject {
  id: string;
  name: string;
}

/** Work item tag from the project Tags catalog. */
export interface AzureDevOpsTag {
  id: string;
  name: string;
}

export interface AzureDevOpsWorkItemType {
  name: string;
  description?: string;
}

export interface AzureDevOpsWorkItemDetail {
  id: number;
  url: string;
  /** Raw field map (System.Title, System.Description HTML, System.State, ...). */
  fields: Record<string, unknown>;
  relations: Array<{
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
  }>;
}

export interface AzureDevOpsComment {
  id: number;
  /** Comment text (HTML). */
  text: string;
  createdBy?: { displayName?: string };
  createdDate: string;
  modifiedDate?: string;
}

/** Comments API is a preview API; pin the version Azure documents. */
const COMMENTS_API_VERSION = "7.1-preview.3";

export class AzureDevOpsClient {
  private organization: string;
  private pat: string;
  private auth: string;
  private defaultProject: string;
  private projectsCache: AzureDevOpsProject[] | null = null;
  private workItemTypesCache = new Map<string, AzureDevOpsWorkItemType[]>();
  private workItemCache = new Map<string, { id: number; url: string }>();

  /**
   * Create an Azure DevOps WIT REST API client.
   *
   * @param config - Organization name, PAT, and default project.
   */
  constructor(config: { organization: string; pat: string; defaultProject: string }) {
    this.organization = config.organization;
    this.pat = config.pat;
    this.defaultProject = config.defaultProject;
    // Azure DevOps PAT auth: username is empty, password is the PAT
    this.auth = Buffer.from(`:${config.pat}`).toString("base64");
  }

  /**
   * Base URL for the configured Azure DevOps organization.
   *
   * @returns Organization root URL (e.g. `https://dev.azure.com/myorg`).
   */
  private get baseUrl(): string {
    return `https://dev.azure.com/${this.organization}`;
  }

  /**
   * Send an authenticated request to the Azure DevOps REST API.
   *
   * @param url - Full request URL.
   * @param method - HTTP method (default `GET`).
   * @param body - Optional request body (JSON or patch document).
   * @param contentType - Request content type (default `application/json`).
   * @returns Parsed JSON response body.
   * @throws When the response status is not OK.
   */
  private async request<T>(
    url: string,
    method: string = "GET",
    body?: unknown,
    contentType: string = "application/json",
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${this.auth}`,
      Accept: "application/json",
    };

    if (body && contentType === "application/json") {
      headers["Content-Type"] = "application/json";
    } else if (body) {
      headers["Content-Type"] = contentType;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure DevOps API error (${response.status}): ${errorText}`);
    }

    return response.json() as T;
  }

  /**
   * Register Service Hook web-hook subscriptions for work item events.
   *
   * Creates one subscription each for `workitem.created` and
   * `workitem.updated`, scoped to the configured project and pointing at the
   * target URL. Service Hooks carry no signature; the target URL itself must
   * be unguessable.
   *
   * @param targetUrl - Webhook target URL (e.g. a relay ingest URL).
   * @param project - Optional project name override.
   * @returns Ids of the created subscriptions.
   * @throws When the Azure DevOps API request fails.
   */
  async createWorkItemWebhooks(targetUrl: string, project?: string): Promise<{ ids: string[] }> {
    const targetProject = project || this.defaultProject;
    const { id: projectId } = await this.request<{ id: string }>(
      `${this.baseUrl}/_apis/projects/${encodeURIComponent(targetProject)}?api-version=7.0`,
    );

    const ids: string[] = [];
    for (const eventType of ["workitem.created", "workitem.updated"]) {
      const subscription = await this.request<{ id: string }>(
        `${this.baseUrl}/_apis/hooks/subscriptions?api-version=7.0`,
        "POST",
        {
          publisherId: "tfs",
          eventType,
          resourceVersion: "1.0",
          consumerId: "webHooks",
          consumerActionId: "httpRequest",
          publisherInputs: { projectId },
          consumerInputs: { url: targetUrl },
        },
      );
      ids.push(subscription.id);
    }
    return { ids };
  }

  /**
   * Create a work item with title and HTML description.
   *
   * @param title - Work item title.
   * @param description - Markdown body (converted to HTML).
   * @param workItemType - Work item type name (e.g. `User Story`).
   * @param project - Optional project name override.
   * @returns Created work item id and edit URL.
   * @throws When the Azure DevOps API request fails.
   */
  async createWorkItem(
    title: string,
    description: string,
    workItemType: string,
    project?: string,
  ): Promise<AzureDevOpsWorkItem> {
    const targetProject = project || this.defaultProject;
    const url = `${this.baseUrl}/${encodeURIComponent(targetProject)}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=7.0`;

    const patchDocument = [
      {
        op: "add",
        path: "/fields/System.Title",
        value: title,
      },
      {
        op: "add",
        path: "/fields/System.Description",
        value: markdownToHtmlDescription(description),
      },
    ];

    const result = await this.request<any>(
      url,
      "POST",
      patchDocument,
      "application/json-patch+json",
    );

    const workItem = {
      id: result.id,
      url: `${this.baseUrl}/${encodeURIComponent(targetProject)}/_workitems/edit/${result.id}`,
    };

    this.workItemCache.set(String(result.id), workItem);

    return workItem;
  }

  /**
   * Create a Task child work item linked to a parent.
   *
   * @param parentId - Parent work item numeric ID.
   * @param title - Subtask title.
   * @param description - Optional markdown body.
   * @param project - Optional project name override.
   * @returns Created work item id and edit URL.
   * @throws When the Azure DevOps API request fails.
   */
  async createSubtask(
    parentId: number,
    title: string,
    description?: string,
    project?: string,
  ): Promise<AzureDevOpsWorkItem> {
    const targetProject = project || this.defaultProject;
    const url = `${this.baseUrl}/${encodeURIComponent(targetProject)}/_apis/wit/workitems/$Task?api-version=7.0`;

    const patchDocument: Array<{ op: string; path: string; value: unknown }> = [
      {
        op: "add",
        path: "/fields/System.Title",
        value: title,
      },
    ];

    if (description) {
      patchDocument.push({
        op: "add",
        path: "/fields/System.Description",
        value: markdownToHtmlDescription(description),
      });
    }

    // Link as child to parent
    patchDocument.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: `${this.baseUrl}/_apis/wit/workItems/${parentId}`,
      },
    });

    const result = await this.request<any>(
      url,
      "POST",
      patchDocument,
      "application/json-patch+json",
    );

    return {
      id: result.id,
      url: `${this.baseUrl}/${encodeURIComponent(targetProject)}/_workitems/edit/${result.id}`,
    };
  }

  /**
   * Add a hierarchy parent link from child to parent work item.
   *
   * @param childId - Child work item numeric ID.
   * @param parentId - Parent work item numeric ID.
   * @throws When the Azure DevOps API request fails.
   */
  async linkToParent(childId: number, parentId: number): Promise<void> {
    const url = `${this.baseUrl}/_apis/wit/workitems/${childId}?api-version=7.0`;

    const patchDocument = [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${this.baseUrl}/_apis/wit/workItems/${parentId}`,
        },
      },
    ];

    await this.request(url, "PATCH", patchDocument, "application/json-patch+json");
  }

  /**
   * Parse a work item key string into a numeric ID.
   *
   * @param key - Work item key (numeric string).
   * @returns Parsed ID, or `undefined` if not numeric.
   */
  async getWorkItemIdByKey(key: string): Promise<number | undefined> {
    // Azure DevOps work items are numeric IDs
    const numericId = parseInt(key, 10);
    if (!isNaN(numericId)) {
      return numericId;
    }
    return undefined;
  }

  /**
   * Fetch a work item by key, using cache when available.
   *
   * @param key - Work item key (numeric string).
   * @returns Work item id and edit URL.
   * @throws When the key is invalid or the API request fails.
   */
  async getWorkItem(key: string): Promise<{ id: number; url: string }> {
    const cached = this.workItemCache.get(key);
    if (cached) {
      return cached;
    }

    const id = await this.getWorkItemIdByKey(key);
    if (!id) {
      throw new Error(`Invalid work item key: ${key}`);
    }

    const result = await this.request<any>(
      `${this.baseUrl}/_apis/wit/workitems/${id}?api-version=7.0`,
    );

    const workItem = {
      id: result.id,
      url: `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_workitems/edit/${result.id}`,
    };

    this.workItemCache.set(key, workItem);
    return workItem;
  }

  /**
   * List projects in the organization (cached after first call).
   *
   * @returns Project id and name records.
   * @throws When the Azure DevOps API request fails.
   */
  async getProjects(): Promise<AzureDevOpsProject[]> {
    if (this.projectsCache) {
      return this.projectsCache;
    }

    const result = await this.request<any>(`${this.baseUrl}/_apis/projects?api-version=7.0`);

    const projects: AzureDevOpsProject[] =
      result.value?.map((project: any) => ({
        id: project.id,
        name: project.name,
      })) || [];

    this.projectsCache = projects;
    return projects;
  }

  /**
   * List work item types for a project (cached per project name).
   *
   * @param project - Optional project name override.
   * @returns Work item type name and description records.
   * @throws When the Azure DevOps API request fails.
   */
  async getWorkItemTypes(project?: string): Promise<AzureDevOpsWorkItemType[]> {
    const targetProject = project || this.defaultProject;

    const cached = this.workItemTypesCache.get(targetProject);
    if (cached) {
      return cached;
    }

    const result = await this.request<any>(
      `${this.baseUrl}/${encodeURIComponent(targetProject)}/_apis/wit/workitemtypes?api-version=7.0`,
    );

    const types: AzureDevOpsWorkItemType[] =
      result.value?.map((type: any) => ({
        name: type.name,
        description: type.description,
      })) || [];

    this.workItemTypesCache.set(targetProject, types);
    return types;
  }

  /**
   * Fetch a work item with all fields and relations expanded.
   *
   * Kept separate from the lightweight {@link getWorkItem} (used by
   * `@devintern/pm`) so existing callers keep their minimal shape.
   *
   * @param key - Work item key (numeric string).
   * @returns Full work item detail.
   * @throws When the key is invalid or the API request fails.
   */
  async getWorkItemDetail(key: string): Promise<AzureDevOpsWorkItemDetail> {
    const id = await this.getWorkItemIdByKey(key);
    if (!id) {
      throw new Error(`Invalid work item key: ${key}`);
    }

    const result = await this.request<any>(
      `${this.baseUrl}/_apis/wit/workitems/${id}?$expand=all&api-version=7.0`,
    );

    return {
      id: result.id,
      url: `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_workitems/edit/${result.id}`,
      fields: result.fields || {},
      relations: result.relations || [],
    };
  }

  /**
   * List comments on a work item (oldest first).
   *
   * @param id - Work item numeric ID.
   * @returns Comment records with HTML text.
   * @throws When the Azure DevOps API request fails.
   */
  async getComments(id: number): Promise<AzureDevOpsComment[]> {
    const result = await this.request<{ comments?: AzureDevOpsComment[] }>(
      `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_apis/wit/workItems/${id}/comments?api-version=${COMMENTS_API_VERSION}`,
    );
    const comments = result.comments || [];
    return [...comments].sort((a, b) => a.createdDate.localeCompare(b.createdDate));
  }

  /**
   * Add a comment to a work item.
   *
   * @param id - Work item numeric ID.
   * @param htmlText - Comment body (HTML).
   * @returns Created comment id.
   * @throws When the Azure DevOps API request fails.
   */
  async addComment(id: number, htmlText: string): Promise<number> {
    const result = await this.request<{ id: number }>(
      `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_apis/wit/workItems/${id}/comments?api-version=${COMMENTS_API_VERSION}`,
      "POST",
      { text: htmlText },
    );
    return result.id;
  }

  /**
   * Update an existing work item comment.
   *
   * @param id - Work item numeric ID.
   * @param commentId - Comment id to update.
   * @param htmlText - New comment body (HTML).
   * @throws When the Azure DevOps API request fails.
   */
  async updateComment(id: number, commentId: number, htmlText: string): Promise<void> {
    await this.request(
      `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${COMMENTS_API_VERSION}`,
      "PATCH",
      { text: htmlText },
    );
  }

  /**
   * Update a single field on a work item via JSON patch.
   *
   * @param id - Work item numeric ID.
   * @param fieldPath - Field reference name (e.g. `System.State`,
   *   `Microsoft.VSTS.Scheduling.StoryPoints`).
   * @param value - New field value.
   * @throws When the Azure DevOps API request fails (e.g. invalid state).
   */
  async updateWorkItemField(id: number, fieldPath: string, value: unknown): Promise<void> {
    const patchDocument = [
      {
        op: "add",
        path: `/fields/${fieldPath}`,
        value,
      },
    ];

    await this.request(
      `${this.baseUrl}/_apis/wit/workitems/${id}?api-version=7.0`,
      "PATCH",
      patchDocument,
      "application/json-patch+json",
    );
  }

  /**
   * Move a work item to a workflow state.
   *
   * @param id - Work item numeric ID.
   * @param state - Target state name (e.g. `Active`, `Resolved`).
   * @throws When the state is invalid for the work item type.
   */
  async updateWorkItemState(id: number, state: string): Promise<void> {
    await this.updateWorkItemField(id, "System.State", state);
  }

  /**
   * List work item tags defined in a project.
   *
   * @param project - Optional project name override.
   * @param maxLabels - Soft catalog cap (default 500).
   * @returns Tag id/name pairs plus truncation when the project has more tags
   *   than the soft cap (API returns the full list; we slice locally).
   * @throws When the Azure DevOps API request fails.
   */
  async getTags(
    project?: string,
    maxLabels: number = 500,
  ): Promise<{ tags: AzureDevOpsTag[]; truncated: boolean }> {
    const targetProject = project || this.defaultProject;
    const result = await this.request<{ value?: Array<{ id?: string; name?: string }> }>(
      `${this.baseUrl}/${encodeURIComponent(targetProject)}/_apis/wit/tags?api-version=7.1`,
    );

    const tags: AzureDevOpsTag[] = [];
    for (const tag of result.value || []) {
      const name = tag.name?.trim();
      if (!name) continue;
      tags.push({ id: tag.id || name, name });
    }

    return {
      tags: tags.slice(0, maxLabels),
      truncated: tags.length > maxLabels,
    };
  }

  /**
   * Replace a work item's `System.Tags` field with the given tag names.
   *
   * Azure DevOps stores tags as a semicolon-separated string. Callers should
   * pass names from {@link getTags}; unknown names are rejected by the engine
   * before this method runs so tags are not auto-created from the picker.
   *
   * @param id - Work item numeric ID.
   * @param tagNames - Tag names to set.
   * @throws When the Azure DevOps API request fails.
   */
  async setWorkItemTags(id: number, tagNames: string[]): Promise<void> {
    const value = tagNames
      .map((name) => name.trim())
      .filter(Boolean)
      .join("; ");
    await this.updateWorkItemField(id, "System.Tags", value);
  }

  /**
   * Download an attachment URL (from work item relations) with PAT auth.
   *
   * @param url - Attachment content URL.
   * @returns Attachment bytes.
   * @throws When the download fails.
   */
  async downloadAttachment(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${this.auth}` },
    });
    if (!response.ok) {
      throw new Error(`Azure DevOps attachment download failed (${response.status})`);
    }
    return response.arrayBuffer();
  }

  /**
   * Upload a local file and attach it to a work item.
   *
   * @param workItemId - Numeric work item ID (or string form of it).
   * @param filePath - Absolute path to the local file.
   * @param options - Optional filename / MIME / project overrides.
   * @throws When upload or relation patch fails.
   */
  async uploadAttachment(
    workItemId: number | string,
    filePath: string,
    options?: { filename?: string; mimeType?: string; project?: string },
  ): Promise<void> {
    const filename = options?.filename || basename(filePath);
    const mimeType = options?.mimeType || mimeTypeFromFilename(filename);
    const project = options?.project || this.defaultProject;
    const bytes = readFileSync(filePath);

    const uploadUrl =
      `${this.baseUrl}/${encodeURIComponent(project)}/_apis/wit/attachments` +
      `?fileName=${encodeURIComponent(filename)}&api-version=7.0`;

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth}`,
        "Content-Type": "application/octet-stream",
        Accept: "application/json",
      },
      body: bytes,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(
        `Azure DevOps attachment upload failed (${uploadResponse.status}): ${errorText}`,
      );
    }

    const uploaded = (await uploadResponse.json()) as { url: string };
    const id = typeof workItemId === "string" ? Number(workItemId) : workItemId;
    if (!Number.isFinite(id)) {
      throw new Error(`Invalid Azure DevOps work item id: ${workItemId}`);
    }

    await this.request(
      `${this.baseUrl}/_apis/wit/workitems/${id}?api-version=7.0`,
      "PATCH",
      [
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "AttachedFile",
            url: uploaded.url,
            attributes: { comment: mimeType },
          },
        },
      ],
      "application/json-patch+json",
    );
  }

  /**
   * Search work items using WIQL (Work Item Query Language).
   *
   * Query syntax: SQL-like WIQL SELECT statement, e.g.
   *   `SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'`
   *   `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'bug'`
   *
   * The query runs scoped to the configured project. Results are capped at
   * 100 work items; titles and change dates are batch-fetched for the
   * returned IDs. `System.ChangedDate` is required: the worker dedupes ready
   * tasks by `(key, updated)`, and an empty stamp never retriggers after the
   * first attempt.
   *
   * WIQL reference:
   *   https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax
   *
   * @param wiql - Full WIQL SELECT statement.
   * @returns Matching work items (id, url, title fields) and total count.
   * @throws When the WIQL is invalid or the API request fails.
   */
  async queryWorkItems(wiql: string): Promise<{
    workItems: Array<AzureDevOpsWorkItem & { title?: string; changedDate?: string }>;
    total: number;
  }> {
    const result = await this.request<{ workItems?: Array<{ id: number }> }>(
      `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_apis/wit/wiql?api-version=7.0&$top=100`,
      "POST",
      { query: wiql },
    );

    const ids = (result.workItems || []).map((item) => item.id);
    if (ids.length === 0) {
      return { workItems: [], total: 0 };
    }

    // Batch-fetch titles and change dates (max 200 IDs per request).
    const workItems: Array<AzureDevOpsWorkItem & { title?: string; changedDate?: string }> = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const details = await this.request<{
        value?: Array<{ id: number; fields?: Record<string, unknown> }>;
      }>(
        `${this.baseUrl}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=System.Id,System.Title,System.ChangedDate&api-version=7.0`,
      );

      for (const item of details.value || []) {
        workItems.push({
          id: item.id,
          url: `${this.baseUrl}/${encodeURIComponent(this.defaultProject)}/_workitems/edit/${item.id}`,
          title: item.fields?.["System.Title"] as string | undefined,
          changedDate: item.fields?.["System.ChangedDate"] as string | undefined,
        });
      }
    }

    return { workItems, total: workItems.length };
  }
}
