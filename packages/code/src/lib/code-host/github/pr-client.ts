import { Utils } from "../../utils";
import { PRClient } from "../base-client";
import { prNumberFromUrl } from "../shared";
import type { PRInfo, PRResult } from "../shared";

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
