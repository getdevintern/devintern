import type { JiraIssue } from "../../types/jira";
import type { Task } from "../../types/task-tracker";
import { GitHubAppAuth } from "./github/app-auth";
import { BitbucketPRClient } from "./bitbucket/pr-client";
import { GitHubPRClient } from "./github/pr-client";
import { GitLabMRClient } from "./gitlab/mr-client";
import { buildPrBody } from "./pr-body";
import { parseGitLabHostAliases, parseGitRemoteUrl } from "./provider";
import type { ChangeRequestIdentity, CodeHostRepository } from "./provider";
import { isTransientPrFailure, parsePrLabels, resolveGitLabCodeHostConfig } from "./shared";
import type { PRInfo, PRResult } from "./shared";

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
   * @param options - PR metadata: `labels` (defaults to the comma-separated
   *   `PR_LABELS` environment variable), `targetBranchExplicit` (whether the
   *   user supplied --pr-target-branch), `requestedTargetBranch` (original
   *   explicit target before Git fallback resolution), and `artifactComment`
   *   (explicitly selected run artifacts published separately from the PR body)
   */
  async createPullRequest(
    task: Task | JiraIssue,
    sourceBranch: string,
    targetBranch = "main",
    implementationSummary?: string,
    options: {
      labels?: string[];
      targetBranchExplicit?: boolean;
      requestedTargetBranch?: string;
      artifactComment?: string;
    } = {},
  ): Promise<PRResult> {
    const labels = options.labels ?? parsePrLabels(process.env.PR_LABELS);
    const targetBranchExplicit = options.targetBranchExplicit ?? true;
    const requestedTargetBranch = options.requestedTargetBranch;
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
      artifactComment: options.artifactComment,
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
      if (result.success && options.artifactComment && repoInfo.platform !== "github") {
        result.artifactPublication = {
          status: "skipped",
          message: `Artifact comments are not supported for ${repoInfo.platform} yet`,
        };
        result.warnings = [...(result.warnings ?? []), result.artifactPublication.message!];
      }
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
   * Find an open pull request for a branch, so an agent-created PR can be
   * adopted (labeled and registered) even when its run failed.
   *
   * Provider support: GitHub today. GitLab and Bitbucket already adopt an
   * existing change request when a duplicate create is attempted; failure-path
   * adoption for them is a follow-up.
   *
   * @param sourceBranch - Head/feature branch name
   * @returns Provider-neutral identity, or `undefined` when no PR exists or the
   *   repository platform is unsupported
   */
  async findOpenChangeRequest(sourceBranch: string): Promise<ChangeRequestIdentity | undefined> {
    const repoInfo = await this.detectRepository();
    if (repoInfo.platform !== "github") return undefined;
    const client = await this.githubClientFor(repoInfo.repository);
    if (!client) return undefined;
    return client.findOpenChangeRequest(repoInfo.repository, sourceBranch);
  }

  /**
   * Apply labels to an existing change request (best-effort).
   *
   * @param identity - Change request returned by {@link findOpenChangeRequest}
   * @param labels - Label names to apply
   */
  async applyLabelsToChangeRequest(
    identity: ChangeRequestIdentity,
    labels: string[],
  ): Promise<void> {
    if (identity.provider !== "github" || labels.length === 0) return;
    const client = await this.githubClientFor(identity.projectPath);
    if (!client) return;
    await client.applyLabelsToChangeRequest(identity.projectPath, identity.number, labels);
  }

  /**
   * Resolve a GitHub client with the token this manager is configured to use.
   *
   * @param repository - `owner/repo` slug (App tokens are scoped per repo)
   * @returns A client, or `undefined` when GitHub is not configured
   */
  private async githubClientFor(repository: string): Promise<GitHubPRClient | undefined> {
    if (this.githubClient) return this.githubClient;
    if (!this.githubAppAuth) return undefined;
    try {
      const [owner, repo] = repository.split("/");
      if (!owner || !repo) return undefined;
      const token = await this.githubAppAuth.getTokenForRepository(owner, repo);
      return new GitHubPRClient(token);
    } catch (error) {
      console.warn(
        `⚠️  Could not resolve a GitHub token for ${repository}: ${(error as Error).message}`,
      );
      return undefined;
    }
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
          const app = prInfo.artifactComment
            ? await this.githubAppAuth.getAppInfo().catch(() => undefined)
            : undefined;
          const client = new GitHubPRClient(token, undefined, app ? `${app.slug}[bot]` : undefined);
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

  /** Build the structured PR body template from task metadata and the summary. */
  private createPRBody(task: Task | JiraIssue, implementationSummary?: string): string {
    const key = (task as Task).key || (task as JiraIssue).key;
    const summary = (task as Task).summary || (task as JiraIssue).fields?.summary || "Unknown";

    return buildPrBody({ taskKey: key, taskSummary: summary, implementationSummary });
  }
}
