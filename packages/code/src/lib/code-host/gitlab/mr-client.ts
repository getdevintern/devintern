import { readFileSync } from "fs";
import { Utils } from "../../utils";
import { PRClient } from "../base-client";
import { normalizeCodeHostUrl } from "../provider";
import { VALIDATED_GITLAB_VERSION } from "../shared";
import type { PRInfo, PRResult } from "../shared";

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
