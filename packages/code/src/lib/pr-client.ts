import type { AtlassianDocument, JiraIssue } from "../types/jira";
import type { Task } from "../types/task-tracker";
import { GitHubAppAuth } from "./github-app-auth";
import { Utils } from "./utils";

export interface PRInfo {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  repository: string;
}

export interface PRResult {
  success: boolean;
  url?: string;
  message: string;
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
        return {
          success: false,
          message: `GitHub PR creation failed: ${errorData.message || response.statusText}`,
        };
      }

      const data = (await response.json()) as any;
      return {
        success: true,
        url: data.html_url,
        message: `Pull request created successfully: ${data.html_url}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `GitHub PR creation failed: ${(error as Error).message}`,
      };
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
      };
    } catch (error) {
      return {
        success: false,
        message: `Bitbucket PR creation failed: ${(error as Error).message}`,
      };
    }
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
  async detectRepository(): Promise<{
    platform: "github" | "bitbucket" | "unknown";
    repository: string;
    workspace?: string;
  }> {
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

          if (remoteUrl.includes("github.com")) {
            // Extract owner/repo from GitHub URL
            const match = remoteUrl.match(/github\.com[:\/]([^/]+)\/([^/.]+)/);
            if (match) {
              return resolve({
                platform: "github",
                repository: `${match[1]}/${match[2]}`,
              });
            }
          } else if (remoteUrl.includes("bitbucket.org")) {
            // Extract workspace/repo from Bitbucket URL
            const match = remoteUrl.match(/bitbucket\.org[:\/]([^/]+)\/([^/.]+)/);
            if (match) {
              return resolve({
                platform: "bitbucket",
                repository: match[2],
                workspace: match[1], // This is the workspace
              });
            }
          }

          resolve({ platform: "unknown", repository: "" });
        });
      });
    } catch (error) {
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
   */
  async createPullRequest(
    task: Task | JiraIssue,
    sourceBranch: string,
    targetBranch = "main",
    implementationSummary?: string,
  ): Promise<PRResult> {
    const repoInfo = await this.detectRepository();

    if (repoInfo.platform === "unknown") {
      return {
        success: false,
        message: "Could not detect repository platform (GitHub or Bitbucket)",
      };
    }

    const taskKey = (task as Task).key || (task as JiraIssue).key;
    const taskSummary = (task as Task).summary || (task as JiraIssue).fields?.summary || "Unknown";

    const prInfo: PRInfo = {
      title: this.createPRTitle(taskKey, taskSummary),
      body: this.createPRBody(task, implementationSummary),
      sourceBranch,
      targetBranch,
      repository: repoInfo.repository,
    };

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
