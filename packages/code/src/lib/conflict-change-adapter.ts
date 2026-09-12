import type { ChangeRequestIdentity } from "./code-host";
import { GitHubReviewsClient } from "./code-host/github/reviews";
import type { PullRequestInfo } from "./code-host/github/reviews";
import { GitLabReviewsClient } from "./code-host/gitlab/reviews";
import { resolveGitLabCodeHostConfig } from "./code-host";
import { GitHubAppAuth } from "./code-host/github/app-auth";
import { Utils } from "./utils";

/** State needed by the conflict workflow. */
export interface ChangeRequestInfo {
  state: string;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string };
  mergeability: "mergeable" | "conflicts" | "behind" | "checking" | "blocked" | "unknown";
}

function githubChangeRequest(pr: PullRequestInfo): ChangeRequestInfo {
  const state = pr.mergeable_state;
  return {
    state: pr.state,
    head: pr.head,
    base: pr.base,
    mergeability:
      state === "dirty"
        ? "conflicts"
        : state === "behind"
          ? "behind"
          : !state || state === "unknown"
            ? "checking"
            : "mergeable",
  };
}

export interface ConflictChangeAdapter {
  fetchChange(): Promise<ChangeRequestInfo>;
  postComment(body: string): Promise<void>;
  configureCommitAuthor(cwd: string): Promise<void>;
}

/** Resolve code-host credentials once, retaining the complete change identity. */
export function createConflictChangeAdapter(
  identity: ChangeRequestIdentity,
  overrides: {
    fetchPr?: (owner: string, repo: string, number: number) => Promise<PullRequestInfo>;
    prCommenter?: (body: string) => Promise<void>;
  } = {},
): ConflictChangeAdapter {
  if (identity.provider === "bitbucket")
    throw new Error("Conflict resolution is unavailable for Bitbucket");
  const [owner = "", repo = ""] = identity.projectPath.split("/");
  const prNumber = identity.number;
  let githubClient: GitHubReviewsClient | undefined;
  const getClient = () => (githubClient ??= new GitHubReviewsClient());
  let gitlabClient: GitLabReviewsClient | undefined;
  if (identity.provider === "gitlab") {
    const config = resolveGitLabCodeHostConfig(identity.instanceUrl);
    if (!config.ok) throw new Error(config.message);
    gitlabClient = new GitLabReviewsClient(config.token, config.instanceUrl, {
      caFile: config.caFile,
      proxy: config.proxy,
    });
  }
  const postComment =
    overrides.prCommenter ??
    (identity.provider === "gitlab"
      ? (body: string) =>
          gitlabClient!.postMergeRequestNote(
            identity.projectId ?? identity.projectPath,
            prNumber,
            body,
          )
      : (body: string) => getClient().postPullRequestComment(owner, repo, prNumber, body));
  const fetchChange = async (): Promise<ChangeRequestInfo> => {
    if (overrides.fetchPr) {
      return githubChangeRequest(await overrides.fetchPr(owner, repo, prNumber));
    }
    if (identity.provider === "gitlab") {
      const mr = await gitlabClient!.getChangeRequest(identity.projectPath, prNumber);
      return { ...mr, state: mr.state === "opened" ? "open" : mr.state };
    }
    return githubChangeRequest(await getClient().getPullRequest(owner, repo, prNumber));
  };

  return {
    fetchChange,
    postComment,
    async configureCommitAuthor(cwd) {
      if (identity.provider === "github" && !process.env.GITHUB_TOKEN) {
        const appAuth = GitHubAppAuth.fromEnvironment();
        if (appAuth) {
          try {
            const author = await appAuth.getGitAuthor();
            await Utils.executeGitCommand(["config", "user.name", author.name], { cwd });
            await Utils.executeGitCommand(["config", "user.email", author.email], { cwd });
          } catch {
            // Local git config applies.
          }
        }
      }
    },
  };
}
