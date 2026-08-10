/**
 * Linear GraphQL API client
 *
 * API docs:
 * - GraphQL Explorer: https://studio.linear.app/graphql
 * - Authentication: https://linear.app/settings/api (personal API keys)
 * - IssueCreate mutation: https://studio.linear.app/graphql (search: IssueCreateInput)
 * - IssueUpdate mutation: https://studio.linear.app/graphql (search: IssueUpdateInput)
 * - Teams query: https://studio.linear.app/graphql (search: TeamConnection)
 * - Issues query: https://studio.linear.app/graphql (search: IssueFilter)
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { mimeTypeFromFilename } from "./mime.ts";

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearLabel {
  /** Present when listed from the labels API; omitted on issue-detail embeds. */
  id?: string;
  name: string;
}

export interface LinearAttachment {
  id: string;
  title: string;
  url: string;
}

export interface LinearIssueDetail extends LinearIssue {
  title: string;
  /** Issue body in markdown. */
  description?: string;
  state?: { id: string; name: string; type: string };
  assignee?: { name: string };
  creator?: { name: string };
  priority?: number;
  priorityLabel?: string;
  estimate?: number;
  labels: LinearLabel[];
  createdAt: string;
  updatedAt: string;
  team?: { id: string; key: string };
  attachments: LinearAttachment[];
}

export interface LinearComment {
  id: string;
  /** Comment body in markdown. */
  body: string;
  createdAt: string;
  updatedAt: string;
  user?: { name: string };
}

const ISSUE_DETAIL_FIELDS = `
  id
  identifier
  url
  title
  description
  priority
  priorityLabel
  estimate
  createdAt
  updatedAt
  state { id name type }
  assignee { name }
  creator { name }
  team { id key }
  labels { nodes { name } }
  attachments { nodes { id title url } }
`;

export class LinearClient {
  private apiKey: string;
  private baseUrl = "https://api.linear.app/graphql";
  private teamsCache: LinearTeam[] | null = null;
  private issueIdCache = new Map<string, string>();
  private workflowStatesCache = new Map<string, LinearWorkflowState[]>();

  /**
   * Create a Linear GraphQL API client.
   *
   * @param config - Personal API key from Linear settings.
   */
  constructor(config: { apiKey: string }) {
    this.apiKey = config.apiKey;
  }

  /**
   * Register a webhook for Issue events across all public teams.
   *
   * @param url - Webhook target URL (e.g. a relay ingest URL).
   * @param secret - Signing secret Linear uses for the `linear-signature` header.
   * @returns The created webhook id.
   * @throws When the API rejects the webhook (e.g. duplicate URL).
   */
  async createWebhook(url: string, secret: string): Promise<{ id: string }> {
    const data = await this.request<{
      webhookCreate: { success: boolean; webhook: { id: string } | null };
    }>(
      `mutation CreateWebhook($input: WebhookCreateInput!) {
        webhookCreate(input: $input) { success webhook { id } }
      }`,
      { input: { url, secret, allPublicTeams: true, resourceTypes: ["Issue"] } },
    );
    if (!data.webhookCreate.success || !data.webhookCreate.webhook) {
      throw new Error("Linear webhook creation did not succeed");
    }
    return { id: data.webhookCreate.webhook.id };
  }

  /**
   * Execute a GraphQL query or mutation against the Linear API.
   *
   * @param query - GraphQL document string.
   * @param variables - Optional GraphQL variables map.
   * @returns The `data` payload from a successful response.
   * @throws When HTTP fails or GraphQL returns errors.
   */
  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Linear API error (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${json.errors[0]?.message}`);
    }

    return json.data as T;
  }

  /**
   * Store an issue identifier → UUID mapping in the in-memory cache.
   *
   * @param identifier - Human-readable issue ID (e.g. `ENG-42`).
   * @param id - Linear internal UUID.
   */
  private cacheIssueId(identifier: string, id: string): void {
    this.issueIdCache.set(identifier, id);
  }

  /**
   * Resolve a Linear issue UUID from its identifier string.
   *
   * @param identifier - Human-readable issue ID (e.g. `ENG-42`).
   * @returns Internal UUID, or `undefined` if not found.
   * @throws When the GraphQL request fails.
   */
  async getIssueIdByIdentifier(identifier: string): Promise<string | undefined> {
    const cached = this.issueIdCache.get(identifier);
    if (cached) {
      return cached;
    }

    const data = await this.request<{
      issues: { nodes: Array<{ id: string; identifier: string }> };
    }>(
      `
      query IssuesByIdentifier($identifier: String!) {
        issues(filter: { identifier: { eq: $identifier } }) {
          nodes {
            id
            identifier
          }
        }
      }
      `,
      { identifier },
    );

    const issue = data.issues.nodes[0];
    if (issue) {
      this.cacheIssueId(issue.identifier, issue.id);
      return issue.id;
    }

    return undefined;
  }

  /**
   * Create a top-level Linear issue in a team.
   *
   * @param title - Issue title.
   * @param description - Issue body (markdown).
   * @param teamId - Target team UUID.
   * @returns Created issue id, identifier, and URL.
   * @throws When creation fails or GraphQL returns unsuccessful result.
   */
  async createIssue(title: string, description: string, teamId: string): Promise<LinearIssue> {
    const data = await this.request<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; url: string };
      };
    }>(
      `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
      `,
      {
        input: {
          title,
          description,
          teamId,
        },
      },
    );

    if (!data.issueCreate.success) {
      throw new Error("Failed to create Linear issue");
    }

    const issue = data.issueCreate.issue;
    this.cacheIssueId(issue.identifier, issue.id);

    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
    };
  }

  /**
   * Create a sub-issue with a parent relationship.
   *
   * @param parentId - Parent issue UUID.
   * @param title - Sub-issue title.
   * @param description - Sub-issue body.
   * @param teamId - Target team UUID.
   * @returns Created sub-issue id, identifier, and URL.
   * @throws When creation fails or GraphQL returns unsuccessful result.
   */
  async createSubIssue(
    parentId: string,
    title: string,
    description: string,
    teamId: string,
  ): Promise<LinearIssue> {
    const data = await this.request<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; url: string };
      };
    }>(
      `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
      `,
      {
        input: {
          title,
          description,
          teamId,
          parentId,
        },
      },
    );

    if (!data.issueCreate.success) {
      throw new Error("Failed to create Linear sub-issue");
    }

    const issue = data.issueCreate.issue;
    this.cacheIssueId(issue.identifier, issue.id);

    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
    };
  }

  /**
   * Set an issue's parent (epic) relationship.
   *
   * @param issueId - Child issue UUID.
   * @param parentId - Parent issue UUID.
   * @throws When the update is unsuccessful or GraphQL fails.
   */
  async linkToParent(issueId: string, parentId: string): Promise<void> {
    const data = await this.request<{
      issueUpdate: { success: boolean };
    }>(
      `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
      `,
      {
        id: issueId,
        input: {
          parentId,
        },
      },
    );

    if (!data.issueUpdate.success) {
      throw new Error("Failed to link issue to parent");
    }
  }

  /**
   * List all teams in the workspace (cached after first call).
   *
   * @returns Team id, key, and name records.
   * @throws When the GraphQL request fails.
   */
  async getTeams(): Promise<LinearTeam[]> {
    if (this.teamsCache) {
      return this.teamsCache;
    }

    const data = await this.request<{
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
    }>(`
      query Teams {
        teams {
          nodes {
            id
            key
            name
          }
        }
      }
    `);

    const teams = data.teams.nodes;
    this.teamsCache = teams;
    return teams;
  }

  /**
   * Look up a team UUID by its short key.
   *
   * @param teamKey - Team key (e.g. `ENG`).
   * @returns Team UUID or `undefined` if not found.
   */
  async getTeamIdByKey(teamKey: string): Promise<string | undefined> {
    const teams = await this.getTeams();
    return teams.find((t) => t.key === teamKey)?.id;
  }

  /**
   * Fetch a full issue by its human-readable identifier (e.g. `ENG-42`).
   *
   * @param identifier - Human-readable issue ID.
   * @returns Full issue detail, or `undefined` if not found.
   * @throws When the GraphQL request fails.
   */
  async getIssueByIdentifier(identifier: string): Promise<LinearIssueDetail | undefined> {
    const data = await this.request<{
      issues: { nodes: Array<Record<string, unknown>> };
    }>(
      `
      query IssueByIdentifier($identifier: String!) {
        issues(filter: { identifier: { eq: $identifier } }, first: 1) {
          nodes {
            ${ISSUE_DETAIL_FIELDS}
          }
        }
      }
      `,
      { identifier },
    );

    const node = data.issues.nodes[0];
    if (!node) return undefined;

    const issue = this.normalizeIssueDetail(node);
    this.cacheIssueId(issue.identifier, issue.id);
    return issue;
  }

  /**
   * List comments on an issue (oldest first).
   *
   * @param issueId - Issue UUID.
   * @throws When the GraphQL request fails.
   */
  async getIssueComments(issueId: string): Promise<LinearComment[]> {
    const data = await this.request<{
      issue: {
        comments: { nodes: LinearComment[] };
      };
    }>(
      `
      query IssueComments($id: String!) {
        issue(id: $id) {
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { name }
            }
          }
        }
      }
      `,
      { id: issueId },
    );

    return [...data.issue.comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Post a markdown comment on an issue.
   *
   * @param issueId - Issue UUID.
   * @param body - Comment body (markdown).
   * @returns Created comment id.
   * @throws When creation fails or GraphQL returns unsuccessful result.
   */
  async createComment(issueId: string, body: string): Promise<string> {
    const data = await this.request<{
      commentCreate: { success: boolean; comment: { id: string } };
    }>(
      `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }
      `,
      { input: { issueId, body } },
    );

    if (!data.commentCreate.success) {
      throw new Error("Failed to create Linear comment");
    }
    return data.commentCreate.comment.id;
  }

  /**
   * Upload a local file and attach it to a Linear issue.
   *
   * Uses `fileUpload` → PUT bytes → `attachmentCreate`. Accepts either an
   * issue UUID or a human identifier (e.g. `ENG-42`).
   *
   * @param issueKeyOrId - Issue UUID or identifier.
   * @param filePath - Absolute path to the local file.
   * @param options - Optional filename / MIME overrides.
   * @throws When upload or attachment creation fails.
   */
  async uploadAttachment(
    issueKeyOrId: string,
    filePath: string,
    options?: { filename?: string; mimeType?: string },
  ): Promise<void> {
    const filename = options?.filename || basename(filePath);
    const mimeType = options?.mimeType || mimeTypeFromFilename(filename);
    const bytes = readFileSync(filePath);

    let issueId = await this.getIssueIdByIdentifier(issueKeyOrId);
    if (!issueId) {
      if (/^[0-9a-f-]{36}$/i.test(issueKeyOrId)) {
        issueId = issueKeyOrId;
      } else {
        throw new Error(`Linear issue not found: ${issueKeyOrId}`);
      }
    }

    const uploadData = await this.request<{
      fileUpload: {
        success: boolean;
        uploadFile?: {
          uploadUrl: string;
          assetUrl: string;
          headers: Array<{ key: string; value: string }>;
        };
      };
    }>(
      `
      mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success
          uploadFile {
            uploadUrl
            assetUrl
            headers {
              key
              value
            }
          }
        }
      }
      `,
      { contentType: mimeType, filename, size: bytes.byteLength },
    );

    if (!uploadData.fileUpload.success || !uploadData.fileUpload.uploadFile) {
      throw new Error("Linear fileUpload mutation failed");
    }

    const { uploadUrl, assetUrl, headers } = uploadData.fileUpload.uploadFile;
    const putHeaders: Record<string, string> = { "Content-Type": mimeType };
    for (const header of headers) {
      putHeaders[header.key] = header.value;
    }

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: putHeaders,
      body: bytes,
    });
    if (!putResponse.ok) {
      const errorText = await putResponse.text();
      throw new Error(`Linear file PUT failed (${putResponse.status}): ${errorText}`);
    }

    const attachData = await this.request<{
      attachmentCreate: { success: boolean };
    }>(
      `
      mutation AttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          success
        }
      }
      `,
      {
        input: {
          issueId,
          title: filename,
          url: assetUrl,
        },
      },
    );

    if (!attachData.attachmentCreate.success) {
      throw new Error("Linear attachmentCreate mutation failed");
    }
  }

  /**
   * Update an existing comment's markdown body.
   *
   * @param commentId - Comment UUID.
   * @param body - New comment body (markdown).
   * @throws When the update is unsuccessful or GraphQL fails.
   */
  async updateComment(commentId: string, body: string): Promise<void> {
    const data = await this.request<{
      commentUpdate: { success: boolean };
    }>(
      `
      mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) {
          success
        }
      }
      `,
      { id: commentId, input: { body } },
    );

    if (!data.commentUpdate.success) {
      throw new Error("Failed to update Linear comment");
    }
  }

  /**
   * List workflow states for a team (cached per team).
   *
   * @param teamId - Team UUID.
   * @throws When the GraphQL request fails.
   */
  async getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const cached = this.workflowStatesCache.get(teamId);
    if (cached) return cached;

    const data = await this.request<{
      team: { states: { nodes: LinearWorkflowState[] } };
    }>(
      `
      query TeamStates($id: String!) {
        team(id: $id) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }
      `,
      { id: teamId },
    );

    const states = data.team.states.nodes;
    this.workflowStatesCache.set(teamId, states);
    return states;
  }

  /**
   * List issue labels available to a team (includes workspace labels).
   *
   * Pages through the label connection until exhausted or {@link maxLabels}.
   * Soft-capped at 500 by default; `truncated` is true when more pages remain.
   *
   * @param teamId - Linear team UUID.
   * @param maxLabels - Soft upper bound on labels returned (default 500).
   * @returns Label id/name pairs plus whether the soft cap truncated.
   * @throws When the GraphQL request fails.
   */
  async getLabels(
    teamId: string,
    maxLabels: number = 500,
  ): Promise<{ labels: Array<{ id: string; name: string }>; truncated: boolean }> {
    type LabelNode = { id: string; name: string };
    type LabelsPage = {
      team: {
        labels: {
          nodes: LabelNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };

    const labels: LabelNode[] = [];
    const pageSize = 100;
    let after: string | null = null;
    let truncated = false;

    while (labels.length < maxLabels) {
      const first = Math.min(pageSize, maxLabels - labels.length);
      const data: LabelsPage = await this.request<LabelsPage>(
        `
        query TeamLabels($teamId: String!, $first: Int!, $after: String) {
          team(id: $teamId) {
            labels(first: $first, after: $after) {
              nodes { id name }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        `,
        { teamId, first, after },
      );

      const connection = data.team?.labels;
      if (!connection) {
        break;
      }
      labels.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
        break;
      }
      after = connection.pageInfo.endCursor;
      if (labels.length >= maxLabels) {
        truncated = true;
        break;
      }
    }

    // Guard against APIs returning more nodes than `first` (or any overshoot):
    // slicing must still report truncated so callers exhaust before Unknown.
    return {
      labels: labels.slice(0, maxLabels),
      truncated: truncated || labels.length > maxLabels,
    };
  }

  /**
   * Replace an issue's labels with the given label ids.
   *
   * @param issueId - Issue UUID.
   * @param labelIds - Linear label UUIDs.
   * @throws When the update is unsuccessful or GraphQL fails.
   */
  async setIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    await this.updateIssue(issueId, { labelIds });
  }

  /**
   * Move an issue to a workflow state.
   *
   * @param issueId - Issue UUID.
   * @param stateId - Target workflow state UUID.
   * @throws When the update is unsuccessful or GraphQL fails.
   */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.updateIssue(issueId, { stateId });
  }

  /**
   * Set an issue's native estimate value.
   *
   * @param issueId - Issue UUID.
   * @param estimate - Estimate points value.
   * @throws When the update is unsuccessful or GraphQL fails.
   */
  async updateIssueEstimate(issueId: string, estimate: number): Promise<void> {
    await this.updateIssue(issueId, { estimate });
  }

  /**
   * Apply an IssueUpdateInput patch to an issue.
   *
   * @param issueId - Issue UUID.
   * @param input - Partial IssueUpdateInput fields.
   * @throws When the update is unsuccessful or GraphQL fails.
   */
  private async updateIssue(issueId: string, input: Record<string, unknown>): Promise<void> {
    const data = await this.request<{
      issueUpdate: { success: boolean };
    }>(
      `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
      `,
      { id: issueId, input },
    );

    if (!data.issueUpdate.success) {
      throw new Error("Failed to update Linear issue");
    }
  }

  /**
   * Search issues using a Linear GraphQL IssueFilter expression.
   *
   * Query syntax: GraphQL IssueFilter object serialized as a JSON string, e.g.
   *   `{"state":{"name":{"eq":"Todo"}}}`
   * or a plain text string matched against the issue title
   * (case-insensitive contains).
   *
   * Full filter schema: https://studio.linear.app/graphql (search: IssueFilter)
   *
   * @param query - JSON IssueFilter or plain text title search.
   * @returns Matching issues (first 50) and total count of returned issues.
   * @throws When the filter JSON is invalid or the GraphQL request fails.
   */
  async searchIssues(query: string): Promise<{ issues: LinearIssueDetail[]; total: number }> {
    let filter: Record<string, unknown>;
    const trimmed = query.trim();

    if (trimmed.startsWith("{")) {
      try {
        filter = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(
          `Invalid Linear IssueFilter JSON: ${error instanceof Error ? error.message : error}. ` +
            "See the IssueFilter schema at https://studio.linear.app/graphql",
        );
      }
    } else {
      filter = { title: { containsIgnoreCase: trimmed } };
    }

    const data = await this.request<{
      issues: { nodes: Array<Record<string, unknown>> };
    }>(
      `
      query SearchIssues($filter: IssueFilter!) {
        issues(filter: $filter, first: 50) {
          nodes {
            ${ISSUE_DETAIL_FIELDS}
          }
        }
      }
      `,
      { filter },
    );

    const issues = data.issues.nodes.map((node) => this.normalizeIssueDetail(node));
    for (const issue of issues) {
      this.cacheIssueId(issue.identifier, issue.id);
    }

    return { issues, total: issues.length };
  }

  /** Flatten GraphQL connection fields into a {@link LinearIssueDetail}. */
  private normalizeIssueDetail(node: Record<string, unknown>): LinearIssueDetail {
    const labels = node.labels as { nodes: LinearLabel[] } | undefined;
    const attachments = node.attachments as { nodes: LinearAttachment[] } | undefined;
    return {
      ...(node as unknown as Omit<LinearIssueDetail, "labels" | "attachments">),
      labels: labels?.nodes ?? [],
      attachments: attachments?.nodes ?? [],
    };
  }
}
