/** GitLab merge-request feedback normalization and mutation primitives. */

import { readFileSync } from "fs";
import type {
  ProcessedConversationComment,
  ProcessedReviewComment,
  ProcessedReviewFeedback,
} from "../types/github-webhooks";
import { normalizeCodeHostUrl } from "./code-host";
import { Utils } from "./utils";

interface GitLabUser {
  id: number;
  username: string;
  state?: string;
  bot?: boolean;
  user_type?: string;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

interface GitLabMergeRequest {
  iid: number;
  title: string;
  state: string;
  sha: string;
  source_branch: string;
  target_branch: string;
  source_project_id: number | null;
  target_project_id: number;
  web_url: string;
  reviewers?: GitLabUser[];
}

interface GitLabPosition {
  old_path?: string;
  new_path?: string;
  old_line?: number | null;
  new_line?: number | null;
}

interface GitLabNote {
  id: number;
  body: string;
  author: GitLabUser;
  created_at: string;
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
  position?: GitLabPosition | null;
}

interface GitLabDiscussion {
  id: string;
  individual_note: boolean;
  notes: GitLabNote[];
}

interface GitLabBranch {
  name: string;
  can_push?: boolean;
}

export interface GitLabReviewClientOptions {
  caFile?: string;
  proxy?: string;
  fetch?: GitLabFetch;
}

type GitLabFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitLabReviewContext {
  projectId: number;
  projectPath: string;
  mergeRequest: GitLabMergeRequest;
  feedback: ProcessedReviewFeedback;
  /** Discussions to reply to after a successful push. */
  discussionIds: string[];
  discussionByNoteId: Record<number, string>;
  /** All note ids included in the prompt, for durable local deduplication. */
  noteIds: number[];
}

export interface GitLabPollingFeedback {
  discussionId: string;
  noteId: number;
  author: GitLabUser;
  createdAt: string;
}

export interface GitLabPollingSnapshot {
  state: string;
  headSha: string;
  webUrl: string;
  assignedReviewerIds: number[];
  feedback: GitLabPollingFeedback[];
}

/** REST API v4 client for manual GitLab merge-request review addressing. */
export class GitLabReviewsClient {
  readonly instanceUrl: string;
  private apiUrl: string;
  private token: string;
  private ca?: string;
  private proxy?: string;
  private fetchImpl: GitLabFetch;

  constructor(token: string, instanceUrl: string, options: GitLabReviewClientOptions = {}) {
    this.instanceUrl = normalizeCodeHostUrl(instanceUrl);
    this.apiUrl = `${this.instanceUrl}/api/v4`;
    this.token = token;
    this.proxy = options.proxy;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (options.caFile) this.ca = readFileSync(options.caFile, "utf8");
  }

  /** Fetch, authorize, and normalize actionable MR discussions. */
  async getReviewContext(projectPath: string, iid: number): Promise<GitLabReviewContext> {
    const [currentUser, project] = await Promise.all([
      this.requestJson<GitLabUser>("/user"),
      this.requestJson<GitLabProject>(`/projects/${encodeURIComponent(projectPath)}`),
    ]);
    const mergeRequest = await this.requestJson<GitLabMergeRequest>(
      `/projects/${project.id}/merge_requests/${iid}`,
    );

    if (mergeRequest.state !== "opened") {
      throw new Error(`MR is ${mergeRequest.state}, not open. Cannot address review.`);
    }
    if (
      mergeRequest.source_project_id !== project.id ||
      mergeRequest.target_project_id !== project.id
    ) {
      throw new Error(
        "Fork merge requests are not supported; manual review addressing requires same-project branches.",
      );
    }

    const accessLevel = Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    );
    if (accessLevel < 30) {
      throw new Error(
        "The configured GitLab identity does not have Developer-or-higher project access.",
      );
    }
    const sourceBranch = await this.requestJson<GitLabBranch>(
      `/projects/${project.id}/repository/branches/${encodeURIComponent(mergeRequest.source_branch)}`,
    );
    if (sourceBranch.can_push !== true) {
      throw new Error(
        `The configured GitLab identity cannot push to source branch '${mergeRequest.source_branch}'.`,
      );
    }

    const discussions = await this.getAllPages<GitLabDiscussion>(
      `/projects/${project.id}/merge_requests/${iid}/discussions`,
    );
    const reviewComments: ProcessedReviewComment[] = [];
    const conversationComments: ProcessedConversationComment[] = [];
    const discussionIds = new Set<string>();
    const discussionByNoteId: Record<number, string> = {};
    const noteIds: number[] = [];
    const reviewers: string[] = [];

    for (const discussion of discussions) {
      const humanNotes = discussion.notes.filter(
        (note) => this.isHumanFeedback(note, currentUser.id) && note.body.trim().length > 0,
      );
      if (humanNotes.length === 0) continue;

      const resolvableNotes = discussion.notes.filter((note) => note.resolvable);
      if (resolvableNotes.length > 0 && resolvableNotes.every((note) => note.resolved === true)) {
        continue;
      }

      for (const note of humanNotes) {
        noteIds.push(note.id);
        discussionIds.add(discussion.id);
        discussionByNoteId[note.id] = discussion.id;
        if (!reviewers.includes(note.author.username)) reviewers.push(note.author.username);

        if (note.position) {
          reviewComments.push({
            id: note.id,
            path: note.position.new_path ?? note.position.old_path ?? "unknown",
            line: note.position.new_line ?? note.position.old_line ?? null,
            side: note.position.new_line == null ? "LEFT" : "RIGHT",
            diffHunk: "",
            body: note.body,
            reviewer: note.author.username,
            isReply: note !== discussion.notes[0],
          });
        } else {
          conversationComments.push({
            id: note.id,
            body: note.body,
            author: note.author.username,
            createdAt: note.created_at,
          });
        }
      }
    }

    return {
      projectId: project.id,
      projectPath: project.path_with_namespace,
      mergeRequest,
      feedback: {
        prNumber: iid,
        prTitle: mergeRequest.title,
        repository: project.path_with_namespace,
        branch: mergeRequest.source_branch,
        reviewer: reviewers.join(", ") || "GitLab reviewer",
        reviewState: reviewComments.length > 0 ? "changes_requested" : "commented",
        reviewBody: null,
        comments: reviewComments,
        ...(conversationComments.length > 0 ? { conversationComments } : {}),
      },
      discussionIds: [...discussionIds],
      discussionByNoteId,
      noteIds,
    };
  }

  /** Fetch lifecycle and unresolved discussion signals for registered-MR polling. */
  async getPollingSnapshot(project: string | number, iid: number): Promise<GitLabPollingSnapshot> {
    const encodedProject = encodeURIComponent(String(project));
    const [currentUser, mergeRequest, discussions] = await Promise.all([
      this.requestJson<GitLabUser>("/user"),
      this.requestJson<GitLabMergeRequest>(`/projects/${encodedProject}/merge_requests/${iid}`),
      this.getAllPages<GitLabDiscussion>(
        `/projects/${encodedProject}/merge_requests/${iid}/discussions`,
      ),
    ]);
    const feedback: GitLabPollingFeedback[] = [];
    for (const discussion of discussions) {
      const unresolved = discussion.notes.some((note) => note.resolvable && note.resolved !== true);
      if (!unresolved) continue;
      for (const note of discussion.notes) {
        if (
          note.resolvable &&
          note.resolved !== true &&
          this.isHumanFeedback(note, currentUser.id) &&
          note.body.trim()
        ) {
          feedback.push({
            discussionId: discussion.id,
            noteId: note.id,
            author: note.author,
            createdAt: note.created_at,
          });
        }
      }
    }
    return {
      state: mergeRequest.state,
      headSha: mergeRequest.sha,
      webUrl: mergeRequest.web_url,
      assignedReviewerIds: (mergeRequest.reviewers ?? []).map((reviewer) => reviewer.id),
      feedback,
    };
  }

  /** Effective project membership for an actor; missing/inaccessible means unknown. */
  async getMemberAccessLevel(project: string | number, userId: number): Promise<number | null> {
    try {
      const member = await this.requestJson<{ access_level: number }>(
        `/projects/${encodeURIComponent(String(project))}/members/all/${userId}`,
      );
      return member.access_level;
    } catch {
      return null;
    }
  }

  /** Abort if the MR branch advanced while the agent was working. */
  async assertHeadSha(projectId: number, iid: number, expectedSha: string): Promise<void> {
    const current = await this.requestJson<GitLabMergeRequest>(
      `/projects/${projectId}/merge_requests/${iid}`,
    );
    if (current.sha !== expectedSha) {
      throw new Error(
        `MR head changed while review feedback was being addressed (${expectedSha} -> ${current.sha}); refusing to push.`,
      );
    }
  }

  /** Reply to discussions without resolving them or changing reviewer assignments. */
  async replyToDiscussions(
    projectId: number,
    iid: number,
    discussionIds: string[],
    body: string,
  ): Promise<{ replied: number; failures: string[] }> {
    let replied = 0;
    const failures: string[] = [];
    for (const discussionId of discussionIds) {
      try {
        await this.requestJson(
          `/projects/${projectId}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
          { method: "POST", body: JSON.stringify({ body }) },
        );
        replied++;
      } catch (error) {
        failures.push(`${discussionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { replied, failures };
  }

  private isHumanFeedback(note: GitLabNote, currentUserId: number): boolean {
    const userType = note.author.user_type?.toLowerCase();
    return (
      !note.system &&
      note.author.id !== currentUserId &&
      note.author.state !== "blocked" &&
      note.author.bot !== true &&
      userType !== "project_bot" &&
      userType !== "bot" &&
      userType !== "service_account"
    );
  }

  private async getAllPages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (let pagesRead = 0; pagesRead < 100; pagesRead++) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${path}${separator}per_page=100&page=${page}`);
      items.push(...((await response.json()) as T[]));
      const next = response.headers.get("x-next-page");
      if (!next) break;
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed <= page) break;
      page = parsed;
    }
    return items;
  }

  private async requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit = {
      ...init,
      headers: {
        "PRIVATE-TOKEN": this.token,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
      ...(this.ca ? { tls: { ca: this.ca } } : {}),
      ...(this.proxy ? { proxy: this.proxy } : {}),
    } as RequestInit;
    const response =
      this.fetchImpl === globalThis.fetch
        ? await Utils.fetchWithRetry(`${this.apiUrl}${path}`, requestInit)
        : await this.fetchImpl(`${this.apiUrl}${path}`, requestInit);
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`.trim();
      try {
        const body = (await response.json()) as { message?: unknown; error?: unknown };
        const value = body.message ?? body.error;
        if (typeof value === "string") detail = value;
        else if (value && typeof value === "object") detail = JSON.stringify(value);
      } catch {
        // Preserve the status fallback for non-JSON errors.
      }
      throw new Error(`GitLab API error (${response.status}): ${detail}`);
    }
    return response;
  }
}
