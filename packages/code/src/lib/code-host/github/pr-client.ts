import { upsertArtifactComment } from "./artifact-comment";
import { Utils } from "../../utils";
import { PRClient } from "../base-client";
import { prNumberFromUrl } from "../shared";
import type { PRInfo, PRResult } from "../shared";
import type { ChangeRequestIdentity } from "../provider";
import { parseStackPr } from "../../dependencies/stack-pr-snapshot";
import type { GitHubPrPayload } from "../../dependencies/stack-pr-snapshot";
import type { StackPrSnapshot } from "../../dependencies/stack-maintainer";

export class GitHubPRClient extends PRClient {
  /**
   * @param token - GitHub personal access token or installation token
   * @param baseUrl - GitHub API base URL
   */
  constructor(
    token: string,
    baseUrl = "https://api.github.com",
    private authorLogin?: string,
  ) {
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
              ...(await this.publishArtifacts(prInfo, number)),
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

        // 400/404/422 are validation errors (no commits between branches, bad
        // base, unknown repo) that a re-run cannot fix. 401/403/429/5xx stay
        // retryable: they cover expired tokens and rate limits.
        const permanent = [400, 404, 422].includes(response.status);
        return {
          success: false,
          ...(permanent ? { permanent: true } : {}),
          message: `GitHub PR creation failed: ${errorData.message || response.statusText}`,
        };
      }

      const data = (await response.json()) as any;
      await this.applyLabels(owner, repo, data.number, prInfo.labels);
      return {
        success: true,
        ...(await this.publishArtifacts(prInfo, data.number)),
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
  private async publishArtifacts(info: PRInfo, number?: number): Promise<Partial<PRResult>> {
    if (!info.artifactComment || !number) return {};
    const artifactPublication = await upsertArtifactComment({
      token: this.token,
      baseUrl: this.baseUrl,
      repository: info.repository,
      number,
      body: info.artifactComment,
      authorLogin: this.authorLogin,
    });
    return {
      artifactPublication,
      ...(artifactPublication.status === "failed"
        ? { warnings: [artifactPublication.message ?? "Artifact publication failed"] }
        : {}),
    };
  }

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
   * Look up an open pull request for the given head branch.
   *
   * @param repository - `owner/repo` slug
   * @param sourceBranch - Head/feature branch name
   * @returns Provider-neutral identity, or `undefined` when none exists
   */
  async findOpenChangeRequest(
    repository: string,
    sourceBranch: string,
  ): Promise<ChangeRequestIdentity | undefined> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) return undefined;
    const url = await this.findExistingPrUrl(owner, repo, sourceBranch);
    const number = prNumberFromUrl(url ?? undefined);
    if (!url || !number) return undefined;
    return {
      provider: "github",
      instanceUrl: "https://github.com",
      projectPath: repository,
      number,
      webUrl: url,
    };
  }

  /**
   * State of the pull request(s) whose head is `sourceBranch`.
   *
   * Queries every state (open, closed, merged) so a merged or closed PR is
   * confirmed rather than inferred from "not in the open list".
   *
   * @param repository - `owner/repo` slug
   * @param sourceBranch - Head/feature branch name
   * @returns `"open"` when any PR for the branch is open, `"closed"` when PRs
   *   exist and all are closed or merged, `"none"` when the branch has no PR
   * @throws When the lookup fails (bad credentials, rate limit, server or
   *   network error), so callers can tell "no PR" from "could not check"
   */
  async getChangeRequestState(
    repository: string,
    sourceBranch: string,
  ): Promise<"open" | "closed" | "none"> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error(`invalid repository slug '${repository}'`);
    const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${sourceBranch}&state=all&per_page=100`;
    const response = await Utils.fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "devintern",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub PR lookup failed: ${response.status} ${response.statusText}`);
    }
    const pulls = (await response.json()) as unknown;
    if (!Array.isArray(pulls)) throw new Error("GitHub PR lookup returned an unexpected body");
    if (pulls.length === 0) return "none";
    return pulls.some((pr) => (pr as { state?: unknown })?.state === "open") ? "open" : "closed";
  }

  /**
   * One pull request's live state (open, merged, or closed), head, and base.
   *
   * @param repository - `owner/repo` slug
   * @param prNumber - Pull request number
   * @returns The snapshot, or `null` when the payload is unusable
   * @throws When the lookup fails (bad credentials, not found, rate limit,
   *   server or network error)
   */
  async getPullRequestSnapshot(
    repository: string,
    prNumber: number,
  ): Promise<StackPrSnapshot | null> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error(`invalid repository slug '${repository}'`);
    const response = await Utils.fetchWithRetry(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "devintern",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub PR lookup failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as unknown;
    if (typeof data !== "object" || data === null) return null;
    return parseStackPr(prNumber, data as GitHubPrPayload);
  }

  /**
   * Apply labels to an existing pull request (best-effort, like create).
   *
   * @param repository - `owner/repo` slug
   * @param prNumber - Pull request number
   * @param labels - Label names to apply
   */
  async applyLabelsToChangeRequest(
    repository: string,
    prNumber: number,
    labels: string[],
  ): Promise<void> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) return;
    await this.applyLabels(owner, repo, prNumber, labels);
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
