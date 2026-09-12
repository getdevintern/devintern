import { readFileSync } from "fs";
import type { AtlassianDocument, JiraIssue } from "../types/jira";
import type { Task } from "../types/task-tracker";
import { normalizeCodeHostUrl, parseGitLabHostAliases, parseGitRemoteUrl } from "./code-host";
import type { ChangeRequestIdentity, CodeHostRepository } from "./code-host";
import { GitHubAppAuth } from "./github-app-auth";
import { Utils } from "./utils";

export interface PRInfo {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  repository: string;
  /** Labels to apply (GitHub; existing project labels only on GitLab). */
  labels?: string[];
}

/**
 * Parse a comma-separated `PR_LABELS` value into label names.
 *
 * @param value - Raw env value, e.g. `"devintern, auto-pr"`
 */
export function parsePrLabels(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

/** Extract the PR number from a PR html_url (`…/pull/123`). */
function prNumberFromUrl(url: string | undefined): number | undefined {
  const parsed = Number(url?.match(/\/pull\/(\d+)/)?.[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface PRResult {
  success: boolean;
  url?: string;
  message: string;
  /** Additive provider-neutral identity for durable state and dashboards. */
  changeRequest?: ChangeRequestIdentity;
  warnings?: string[];
}

const VALIDATED_GITLAB_VERSION = "19.3";

/** Whether the experimental GitLab code-host integration is explicitly enabled. */
export function isGitLabCodeHostEnabled(
  value = process.env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST,
) {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

export type GitLabCodeHostConfigResult =
  | {
      ok: true;
      instanceUrl: string;
      token: string;
      caFile?: string;
      proxy?: string;
    }
  | { ok: false; message: string };

/** Resolve the default GitLab code-host profile without crossing token boundaries. */
export function resolveGitLabCodeHostConfig(
  remoteInstanceUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): GitLabCodeHostConfigResult {
  if (!isGitLabCodeHostEnabled(env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST)) {
    return {
      ok: false,
      message:
        "GitLab code-host support is experimental. Set DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST=true to enable it.",
    };
  }

  let instanceUrl: string;
  try {
    instanceUrl = normalizeCodeHostUrl(env.GITLAB_CODE_HOST_URL || "https://gitlab.com");
  } catch (error) {
    return { ok: false, message: `Invalid GITLAB_CODE_HOST_URL: ${(error as Error).message}` };
  }
  if (remoteInstanceUrl !== instanceUrl) {
    return {
      ok: false,
      message: `GitLab remote belongs to ${remoteInstanceUrl}, but the configured code-host profile is ${instanceUrl}`,
    };
  }

  let token = env.GITLAB_CODE_HOST_TOKEN;
  if (!token && (env.TASK_TRACKER ?? "").toLowerCase() === "gitlab") {
    try {
      const trackerUrl = normalizeCodeHostUrl(env.GITLAB_BASE_URL || "https://gitlab.com");
      if (trackerUrl === instanceUrl) token = env.GITLAB_TOKEN;
    } catch {
      // An invalid tracker URL cannot authorize fallback to its token.
    }
  }
  if (!token) {
    return {
      ok: false,
      message:
        "GitLab code-host client not configured. Set GITLAB_CODE_HOST_TOKEN; the tracker token is reused only when both instance URLs match.",
    };
  }

  return {
    ok: true,
    instanceUrl,
    token,
    caFile: env.GITLAB_CODE_HOST_CA_FILE,
    proxy: env.GITLAB_CODE_HOST_PROXY,
  };
}

/**
 * Match PR-creation failures worth retrying: DNS/connect failures, timeouts,
 * and other transport-level errors. Deliberately conservative so API-level
 * validation errors (401/404/422 "Validation Failed", etc.) fail fast.
 */
export function isTransientPrFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("typo in the url or port") ||
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("socket hang up") ||
    m.includes("epipe") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("econnaborted") ||
    m.includes("etimedout") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("enotfound") ||
    m.includes("eai_again") ||
    m.includes("unable to connect") ||
    m.includes("unable to resolve") ||
    m.includes("getaddrinfo")
  );
}

export abstract class PRClient {
  protected token: string;
  protected baseUrl: string;

  /**
   * @param token - Platform API token
   * @param baseUrl - REST API base URL
   */
  constructor(token: string, baseUrl: string) {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  /** Create a pull request on the target platform. */
  abstract createPullRequest(prInfo: PRInfo): Promise<PRResult>;

  /**
   * Build a standard PR title from task metadata.
   *
   * @param taskKey - Task tracker issue key
   * @param taskSummary - Issue summary line
   */
  protected createPRTitle(taskKey: string, taskSummary: string): string {
    return `[${taskKey}] ${taskSummary}`;
  }

  /**
   * Extract plain text from an Atlassian Document or string body.
   *
   * @param doc - ADF document or plain string
   */
  protected convertAtlassianDocumentToString(doc: AtlassianDocument | string): string {
    if (typeof doc === "string") {
      return doc;
    }

    // Simple conversion - extract text content from Atlassian Document Format
    const extractText = (nodes: any[]): string => {
      if (!nodes) return "";

      return nodes
        .map((node) => {
          if (node.type === "text") {
            return node.text || "";
          }
          if (node.content) {
            return extractText(node.content);
          }
          return "";
        })
        .join("");
    };

    return extractText(doc.content);
  }

  /**
   * Build default PR description markdown from task tracker details.
   *
   * @param task - Source task (JIRA issue or generic Task)
   * @param implementationSummary - Optional agent implementation summary
   */
  protected createPRBody(task: Task | JiraIssue, implementationSummary?: string): string {
    const key = (task as Task).key || (task as JiraIssue).key;
    const summary = (task as Task).summary || (task as JiraIssue).fields?.summary || "Unknown";

    const lines = [`## Task: ${key}`, "", `**Summary:** ${summary}`, ""];

    if (implementationSummary) {
      lines.push("## Implementation Details");
      lines.push("");
      lines.push(implementationSummary);
      lines.push("");
    }

    lines.push("---");
    lines.push("*This PR was automatically created by @devintern/code*");

    return lines.join("\n");
  }
}

export class GitHubPRClient extends PRClient {
  /**
   * @param token - GitHub personal access token or installation token
   * @param baseUrl - GitHub API base URL
   */
  constructor(token: string, baseUrl = "https://api.github.com") {
    super(token, baseUrl);
  }

  /** @inheritdoc PRClient.createPullRequest */
  async createPullRequest(prInfo: PRInfo): Promise<PRResult> {
    try {
      const [owner, repo] = prInfo.repository.split("/");
      const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls`;

      const response = await Utils.fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "devintern",
        },
        body: JSON.stringify({
          title: prInfo.title,
          body: prInfo.body,
          head: prInfo.sourceBranch,
          base: prInfo.targetBranch,
          draft: false,
        }),
      });

      if (!response.ok) {
        const errorData = (await response
          .json()
          .catch(() => ({ message: "Unknown error" }))) as any;

        // Idempotency: if the create request reached GitHub but the response
        // was lost and retried, GitHub rejects the duplicate with 422. Treat a
        // PR that already exists for this branch as success so the run can
        // proceed to status transitions instead of leaving the ticket stuck.
        if (response.status === 422) {
          const existingUrl = await this.findExistingPrUrl(owner, repo, prInfo.sourceBranch);
          if (existingUrl) {
            const number = prNumberFromUrl(existingUrl);
            await this.applyLabels(owner, repo, prNumberFromUrl(existingUrl), prInfo.labels);
            return {
              success: true,
              url: existingUrl,
              message: `Pull request already exists: ${existingUrl}`,
              ...(number
                ? {
                    changeRequest: {
                      provider: "github" as const,
                      instanceUrl: "https://github.com",
                      projectPath: prInfo.repository,
                      number,
                      webUrl: existingUrl,
                    },
                  }
                : {}),
            };
          }
        }

        return {
          success: false,
          message: `GitHub PR creation failed: ${errorData.message || response.statusText}`,
        };
      }

      const data = (await response.json()) as any;
      await this.applyLabels(owner, repo, data.number, prInfo.labels);
      return {
        success: true,
        url: data.html_url,
        message: `Pull request created successfully: ${data.html_url}`,
        ...(data.number
          ? {
              changeRequest: {
                provider: "github" as const,
                instanceUrl: "https://github.com",
                projectPath: prInfo.repository,
                number: data.number as number,
                webUrl: data.html_url as string,
              },
            }
          : {}),
      };
    } catch (error) {
      return {
        success: false,
        message: `GitHub PR creation failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Label a PR (PRs are issues in the GitHub API). Best-effort: labeling is
   * decoration on top of a successful create, so failures warn but never
   * fail the run.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - PR number
   * @param labels - Label names to apply
   */
  private async applyLabels(
    owner: string,
    repo: string,
    prNumber: number | undefined,
    labels?: string[],
  ): Promise<void> {
    if (!labels || labels.length === 0 || !prNumber) return;

    try {
      const url = `${this.baseUrl}/repos/${owner}/${repo}/issues/${prNumber}/labels`;
      const response = await Utils.fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "devintern",
        },
        body: JSON.stringify({ labels }),
      });
      if (!response.ok) {
        console.warn(
          `⚠️  Could not label PR #${prNumber}: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      console.warn(`⚠️  Could not label PR #${prNumber}: ${(error as Error).message}`);
    }
  }

  /**
   * Look up an open PR for the given head branch.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param headBranch - Head/feature branch name
   * @returns The existing PR's html_url, or null when none is found
   */
  private async findExistingPrUrl(
    owner: string,
    repo: string,
    headBranch: string,
  ): Promise<string | null> {
    try {
      const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${headBranch}&state=open&per_page=1`;
      const response = await Utils.fetchWithRetry(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "devintern",
        },
      });
      if (!response.ok) return null;
      const pulls = (await response.json()) as Array<{ html_url?: string }>;
      const match = pulls.find((pr) => pr.html_url);
      return match?.html_url ?? null;
    } catch {
      return null;
    }
  }
}

export class BitbucketPRClient extends PRClient {
  private workspace: string;

  /**
   * @param token - Bitbucket app password or access token
   * @param workspace - Bitbucket workspace slug
   * @param baseUrl - Bitbucket API base URL
   */
  constructor(token: string, workspace: string, baseUrl = "https://api.bitbucket.org/2.0") {
    super(token, baseUrl);
    this.workspace = workspace;
  }

  /** @inheritdoc PRClient.createPullRequest */
  async createPullRequest(prInfo: PRInfo): Promise<PRResult> {
    try {
      const url = `${this.baseUrl}/repositories/${this.workspace}/${prInfo.repository}/pullrequests`;

      const response = await Utils.fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: prInfo.title,
          description: prInfo.body,
          source: {
            branch: {
              name: prInfo.sourceBranch,
            },
          },
          destination: {
            branch: {
              name: prInfo.targetBranch,
            },
          },
          close_source_branch: false,
        }),
      });

      if (!response.ok) {
        const errorData = (await response
          .json()
          .catch(() => ({ error: { message: "Unknown error" } }))) as any;
        return {
          success: false,
          message: `Bitbucket PR creation failed: ${
            errorData.error?.message || response.statusText
          }`,
        };
      }

      const data = (await response.json()) as any;
      return {
        success: true,
        url: data.links.html.href,
        message: `Pull request created successfully: ${data.links.html.href}`,
        ...(data.id
          ? {
              changeRequest: {
                provider: "bitbucket" as const,
                instanceUrl: "https://bitbucket.org",
                projectPath: `${this.workspace}/${prInfo.repository}`,
                number: data.id as number,
                webUrl: data.links.html.href as string,
              },
            }
          : {}),
      };
    } catch (error) {
      return {
        success: false,
        message: `Bitbucket PR creation failed: ${(error as Error).message}`,
      };
    }
  }
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
}

interface GitLabMergeRequest {
  iid: number;
  web_url: string;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  labels?: string[];
}

interface GitLabClientOptions {
  caFile?: string;
  proxy?: string;
}

/** Experimental GitLab.com and GitLab Self-Managed merge-request creator. */
export class GitLabMRClient extends PRClient {
  private apiUrl: string;
  private ca?: string;
  private proxy?: string;

  constructor(
    token: string,
    instanceUrl = "https://gitlab.com",
    options: GitLabClientOptions = {},
  ) {
    const normalized = normalizeCodeHostUrl(instanceUrl);
    super(token, normalized);
    this.apiUrl = `${normalized}/api/v4`;
    this.proxy = options.proxy;
    if (options.caFile) {
      this.ca = readFileSync(options.caFile, "utf8");
    }
  }

  /** @inheritdoc PRClient.createPullRequest */
  async createPullRequest(prInfo: PRInfo): Promise<PRResult> {
    const warnings: string[] = [];
    try {
      await this.checkVersion(warnings);
      const project = await this.resolveProject(prInfo.repository);
      const targetBranch = prInfo.targetBranch || project.default_branch;
      if (!targetBranch) {
        return {
          success: false,
          message: `GitLab project ${project.path_with_namespace} has no default branch`,
          warnings,
        };
      }

      await this.requireBranch(project.id, prInfo.sourceBranch, "source");
      await this.requireBranch(project.id, targetBranch, "target");
      const labels = await this.filterExistingLabels(project.id, prInfo.labels ?? [], warnings);

      const response = await this.request(`/projects/${project.id}/merge_requests`, {
        method: "POST",
        body: JSON.stringify({
          title: prInfo.title,
          description: prInfo.body,
          source_branch: prInfo.sourceBranch,
          target_branch: targetBranch,
          remove_source_branch: false,
          ...(labels.length > 0 ? { labels: labels.join(",") } : {}),
        }),
      });

      if (!response.ok) {
        if ([400, 409, 422].includes(response.status)) {
          const existing = await this.findExistingMergeRequest(
            project.id,
            prInfo.sourceBranch,
            targetBranch,
          );
          if (existing) {
            await this.addLabels(project.id, existing, labels, warnings);
            return this.successResult(project, existing, true, warnings);
          }
        }
        return {
          success: false,
          message: `GitLab MR creation failed: ${await this.errorMessage(response)}`,
          warnings,
        };
      }

      const mergeRequest = (await response.json()) as GitLabMergeRequest;
      return this.successResult(project, mergeRequest, false, warnings);
    } catch (error) {
      return {
        success: false,
        message: `GitLab MR creation failed: ${(error as Error).message}`,
        warnings,
      };
    }
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
    return await Utils.fetchWithRetry(`${this.apiUrl}${path}`, requestInit);
  }

  private async resolveProject(projectPath: string): Promise<GitLabProject> {
    const response = await this.request(`/projects/${encodeURIComponent(projectPath)}`);
    if (!response.ok) {
      throw new Error(`project lookup failed: ${await this.errorMessage(response)}`);
    }
    return (await response.json()) as GitLabProject;
  }

  private async requireBranch(projectId: number, branch: string, role: string): Promise<void> {
    const response = await this.request(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
    );
    if (!response.ok) {
      throw new Error(`${role} branch '${branch}' was not found or is inaccessible`);
    }
  }

  private async filterExistingLabels(
    projectId: number,
    requested: string[],
    warnings: string[],
  ): Promise<string[]> {
    if (requested.length === 0) return [];
    try {
      const existing = new Map<string, string>();
      let page = 1;
      for (let pagesRead = 0; pagesRead < 100; pagesRead++) {
        const response = await this.request(
          `/projects/${projectId}/labels?per_page=100&page=${page}`,
        );
        if (!response.ok) throw new Error(await this.errorMessage(response));
        const labels = (await response.json()) as Array<{ name: string }>;
        for (const label of labels) existing.set(label.name.toLowerCase(), label.name);
        const nextPage =
          response.headers.get("x-next-page") ||
          this.nextPageFromLink(response.headers.get("link"));
        if (!nextPage) break;
        const parsed = Number.parseInt(nextPage, 10);
        if (!Number.isInteger(parsed) || parsed <= page) break;
        page = parsed;
      }

      const found: string[] = [];
      const missing: string[] = [];
      for (const label of requested) {
        const canonical = existing.get(label.toLowerCase());
        if (canonical) found.push(canonical);
        else missing.push(label);
      }
      if (missing.length > 0) {
        this.warn(warnings, `GitLab labels do not exist and were skipped: ${missing.join(", ")}`);
      }
      return found;
    } catch (error) {
      this.warn(
        warnings,
        `Could not verify GitLab labels; no labels were applied: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private nextPageFromLink(link: string | null): string | null {
    if (!link) return null;
    const next = link.split(",").find((entry) => /rel="?next"?/i.test(entry));
    const target = next?.match(/<([^>]+)>/)?.[1];
    if (!target) return null;
    try {
      return new URL(target).searchParams.get("page");
    } catch {
      return null;
    }
  }

  private async findExistingMergeRequest(
    projectId: number,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<GitLabMergeRequest | null> {
    try {
      const params = new URLSearchParams({
        state: "opened",
        source_branch: sourceBranch,
        target_branch: targetBranch,
        scope: "all",
        per_page: "100",
      });
      const response = await this.request(`/projects/${projectId}/merge_requests?${params}`);
      if (!response.ok) return null;
      const mergeRequests = (await response.json()) as GitLabMergeRequest[];
      return (
        mergeRequests.find(
          (mergeRequest) =>
            mergeRequest.source_project_id === projectId &&
            mergeRequest.target_project_id === projectId &&
            mergeRequest.source_branch === sourceBranch &&
            mergeRequest.target_branch === targetBranch,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private async addLabels(
    projectId: number,
    mergeRequest: GitLabMergeRequest,
    labels: string[],
    warnings: string[],
  ): Promise<void> {
    const applied = new Set((mergeRequest.labels ?? []).map((label) => label.toLowerCase()));
    const missing = labels.filter((label) => !applied.has(label.toLowerCase()));
    if (missing.length === 0) return;
    try {
      const response = await this.request(
        `/projects/${projectId}/merge_requests/${mergeRequest.iid}`,
        { method: "PUT", body: JSON.stringify({ add_labels: missing.join(",") }) },
      );
      if (!response.ok) throw new Error(await this.errorMessage(response));
    } catch (error) {
      this.warn(
        warnings,
        `Could not label GitLab MR !${mergeRequest.iid}: ${(error as Error).message}`,
      );
    }
  }

  private async checkVersion(warnings: string[]): Promise<void> {
    if (this.baseUrl === "https://gitlab.com") return;
    try {
      const response = await this.request("/version");
      if (!response.ok) throw new Error(await this.errorMessage(response));
      const data = (await response.json()) as { version?: string };
      if (data.version && !data.version.startsWith(`${VALIDATED_GITLAB_VERSION}.`)) {
        this.warn(
          warnings,
          `GitLab ${data.version} is outside the validated ${VALIDATED_GITLAB_VERSION}.x release; continuing best-effort`,
        );
      }
    } catch (error) {
      this.warn(warnings, `Could not verify the GitLab version: ${(error as Error).message}`);
    }
  }

  private successResult(
    project: GitLabProject,
    mergeRequest: GitLabMergeRequest,
    existing: boolean,
    warnings: string[],
  ): PRResult {
    return {
      success: true,
      url: mergeRequest.web_url,
      message: `Merge request ${existing ? "already exists" : "created successfully"}: ${mergeRequest.web_url}`,
      changeRequest: {
        provider: "gitlab",
        instanceUrl: this.baseUrl,
        projectId: String(project.id),
        projectPath: project.path_with_namespace,
        number: mergeRequest.iid,
        webUrl: mergeRequest.web_url,
      },
      warnings,
    };
  }

  private async errorMessage(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      error?: unknown;
    } | null;
    const detail = body?.message ?? body?.error;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    return `${response.status} ${response.statusText}`.trim();
  }

  private warn(warnings: string[], message: string): void {
    warnings.push(message);
    console.warn(`⚠️  ${message}`);
  }
}

export class PRManager {
  private githubClient?: GitHubPRClient;
  private githubAppAuth?: GitHubAppAuth;

  /** Initialize GitHub clients from environment (PAT preferred over App auth). */
  constructor() {
    // Initialize GitHub client - prefer personal token over App auth
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      this.githubClient = new GitHubPRClient(githubToken);
    } else {
      // Try GitHub App authentication
      const appAuth = GitHubAppAuth.fromEnvironment();
      if (appAuth) {
        this.githubAppAuth = appAuth;
        console.log("🔑 Using GitHub App authentication for PR creation");
      }
    }
  }

  /** Extract plain text from ADF for PR bodies (duplicate of base helper). */
  private convertAtlassianDocumentToString(doc: AtlassianDocument | string): string {
    if (typeof doc === "string") {
      return doc;
    }

    // Simple conversion - extract text content from Atlassian Document Format
    const extractText = (nodes: any[]): string => {
      if (!nodes) return "";

      return nodes
        .map((node) => {
          if (node.type === "text") {
            return node.text || "";
          }
          if (node.content) {
            return extractText(node.content);
          }
          return "";
        })
        .join("");
    };

    return extractText(doc.content);
  }

  /**
   * Detect VCS platform and repository slug from `git remote get-url origin`.
   *
   * @returns GitHub or Bitbucket metadata, or `unknown` when detection fails
   */
  async detectRepository(): Promise<
    | (CodeHostRepository & { platform: CodeHostRepository["provider"] })
    | { platform: "unknown"; repository: string }
  > {
    try {
      // Get remote URL
      const { spawn } = await import("child_process");
      const git = spawn("git", ["remote", "get-url", "origin"]);

      let output = "";
      git.stdout.on("data", (data) => {
        output += data.toString();
      });

      return new Promise((resolve) => {
        git.on("close", () => {
          const remoteUrl = output.trim();

          const parsed = parseGitRemoteUrl(remoteUrl, {
            gitlabBaseUrl: process.env.GITLAB_CODE_HOST_URL,
            gitlabHostAliases: parseGitLabHostAliases(process.env.GITLAB_CODE_HOST_ALIASES),
          });
          if (parsed) return resolve({ ...parsed, platform: parsed.provider });

          resolve({ platform: "unknown", repository: "" });
        });
      });
    } catch {
      return { platform: "unknown", repository: "" };
    }
  }

  /**
   * Create a pull request for a completed task implementation.
   *
   * @param task - Source task (generic Task or JiraIssue)
   * @param sourceBranch - Head/feature branch name
   * @param targetBranch - Base branch (default `main`)
   * @param implementationSummary - Optional summary appended to PR body
   * @param labels - Labels to apply to the PR; defaults to the comma-separated
   *   `PR_LABELS` environment variable
   * @param targetBranchExplicit - Whether the user supplied --pr-target-branch
   * @param requestedTargetBranch - Original explicit target before Git fallback resolution
   */
  async createPullRequest(
    task: Task | JiraIssue,
    sourceBranch: string,
    targetBranch = "main",
    implementationSummary?: string,
    labels: string[] = parsePrLabels(process.env.PR_LABELS),
    targetBranchExplicit = true,
    requestedTargetBranch?: string,
  ): Promise<PRResult> {
    const repoInfo = await this.detectRepository();

    if (repoInfo.platform === "unknown") {
      return {
        success: false,
        message: "Could not detect repository platform (GitHub, GitLab, or Bitbucket)",
      };
    }

    const taskKey = (task as Task).key || (task as JiraIssue).key;
    const taskSummary = (task as Task).summary || (task as JiraIssue).fields?.summary || "Unknown";

    const prInfo: PRInfo = {
      title: this.createPRTitle(taskKey, taskSummary),
      body: this.createPRBody(task, implementationSummary),
      sourceBranch,
      targetBranch:
        repoInfo.platform === "gitlab"
          ? targetBranchExplicit
            ? (requestedTargetBranch ?? targetBranch)
            : ""
          : targetBranch,
      repository: repoInfo.repository,
      ...(labels.length > 0 ? { labels } : {}),
    };

    // A transient network blip between push and PR creation used to leave the
    // branch pushed but no PR and the ticket stuck In Progress (e.g. DNS
    // failures surfacing as "Was there a typo in the url or port?"). Retry
    // transport-level failures with backoff; idempotency for duplicate creates
    // is handled by each provider client's exact existing-change lookup.
    const maxAttempts = 3;
    let result: PRResult = {
      success: false,
      message: "PR creation was not attempted",
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result = await this.dispatchCreatePullRequest(prInfo, repoInfo);
      if (result.success || !isTransientPrFailure(result.message)) {
        return result;
      }
      if (attempt < maxAttempts) {
        const delayMs = 2000 * 2 ** (attempt - 1);
        console.warn(
          `⚠️  Transient failure creating PR (${result.message}); retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return result;
  }

  /**
   * Dispatch PR creation to the platform-specific client.
   *
   * @param prInfo - Assembled PR metadata
   * @param repoInfo - Detected platform and repository slug
   */
  private async dispatchCreatePullRequest(
    prInfo: PRInfo,
    repoInfo: {
      platform: "github" | "gitlab" | "bitbucket" | "unknown";
      repository: string;
      workspace?: string;
      instanceUrl?: string;
    },
  ): Promise<PRResult> {
    if (repoInfo.platform === "github") {
      // Use existing client with personal token
      if (this.githubClient) {
        return await this.githubClient.createPullRequest(prInfo);
      }

      // Use GitHub App authentication
      if (this.githubAppAuth) {
        try {
          const [owner, repo] = repoInfo.repository.split("/");
          const token = await this.githubAppAuth.getTokenForRepository(owner, repo);
          const client = new GitHubPRClient(token);
          return await client.createPullRequest(prInfo);
        } catch (error) {
          return {
            success: false,
            message: `GitHub App authentication failed: ${(error as Error).message}`,
          };
        }
      }

      return {
        success: false,
        message:
          "GitHub client not configured. Please set GITHUB_TOKEN or configure GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH).",
      };
    }

    if (repoInfo.platform === "bitbucket") {
      // Create Bitbucket client dynamically with detected workspace
      const bitbucketToken = process.env.BITBUCKET_TOKEN;

      if (!bitbucketToken) {
        return {
          success: false,
          message:
            "Bitbucket client not configured. Please set BITBUCKET_TOKEN environment variable.",
        };
      }

      if (!repoInfo.workspace) {
        return {
          success: false,
          message: "Could not detect Bitbucket workspace from git remote URL.",
        };
      }

      const bitbucketClient = new BitbucketPRClient(bitbucketToken, repoInfo.workspace);
      return await bitbucketClient.createPullRequest(prInfo);
    }

    if (repoInfo.platform === "gitlab") {
      try {
        const config = resolveGitLabCodeHostConfig(repoInfo.instanceUrl ?? "");
        if (!config.ok) return { success: false, message: config.message };

        console.warn(`⚠️  Experimental GitLab code-host support enabled for ${config.instanceUrl}`);
        const client = new GitLabMRClient(config.token, config.instanceUrl, {
          caFile: config.caFile,
          proxy: config.proxy,
        });
        return await client.createPullRequest(prInfo);
      } catch (error) {
        return {
          success: false,
          message: `GitLab code-host configuration failed: ${(error as Error).message}`,
        };
      }
    }

    // This shouldn't be reached since we handle unknown platform at the start
    return {
      success: false,
      message: "Unsupported repository platform.",
    };
  }

  /** @inheritdoc PRClient.createPRTitle */
  private createPRTitle(taskKey: string, taskSummary: string): string {
    return `[${taskKey}] ${taskSummary}`;
  }

  /** @inheritdoc PRClient.createPRBody */
  private createPRBody(task: Task | JiraIssue, implementationSummary?: string): string {
    const key = (task as Task).key || (task as JiraIssue).key;
    const summary = (task as Task).summary || (task as JiraIssue).fields?.summary || "Unknown";

    const lines = [`## Task: ${key}`, "", `**Summary:** ${summary}`, ""];

    if (implementationSummary) {
      lines.push("## Implementation Details");
      lines.push("");
      lines.push(implementationSummary);
      lines.push("");
    }

    lines.push("---");
    lines.push("*This PR was automatically created by @devintern/code*");

    return lines.join("\n");
  }
}
