/**
 * Merge-conflict resolution for the agent's own PRs.
 *
 * When a watched PR falls behind its base and GitHub reports it conflicting
 * (`mergeable_state: "dirty"`), the worker merges the base branch into the PR
 * branch inside the review worktree. A clean merge is committed and pushed
 * directly; a conflicted merge hands the conflicted files to the agent to
 * resolve, then verifies nothing is left unmerged before pushing.
 *
 * Guardrails: only the agent's own PRs are handled (the review poller's
 * watch list), fork PRs are skipped, and pushes are never forced — if a
 * human pushed to the branch meanwhile, the push is rejected and the merge
 * is left for them.
 */

import { runAgent } from "./address-review";
import { GitHubAppAuth } from "./github-app-auth";
import { GitHubReviewsClient, type PullRequestInfo } from "./github-reviews";
import { Utils } from "./utils";

export interface ResolveConflictsOptions {
  verbose?: boolean;
  /** Skip pushing (dry runs / tests). */
  noPush?: boolean;
  /** Skip the PR outcome comment (tests). */
  noComment?: boolean;
  /** Source repository directory (defaults to the current directory). */
  cwd?: string;
  /** Injected agent runner (tests). Defaults to the shared review agent. */
  agentRunner?: (
    prompt: string,
    workDir: string,
    verbose: boolean,
  ) => Promise<{ success: boolean; output: string }>;
  /** Injected PR fetch (tests). Defaults to the GitHub API. */
  fetchPr?: (owner: string, repo: string, prNumber: number) => Promise<PullRequestInfo>;
}

export interface ResolveConflictsResult {
  /** `resolved` = merge pushed; `clean` = base merged without conflicts. */
  outcome: "clean" | "resolved" | "skipped" | "failed";
  message: string;
}

/** Parse an `owner/repo` + PR number out of a GitHub PR URL. */
function parsePrUrl(prUrl: string): { owner: string; repo: string; prNumber: number } {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Not a GitHub PR URL: ${prUrl}`);
  }
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

/** Build the agent prompt for resolving a conflicted merge. */
export function buildConflictPrompt(options: {
  baseRef: string;
  branch: string;
  conflictedFiles: string[];
}): string {
  return `# Resolve Merge Conflicts

A merge of \`origin/${options.baseRef}\` into \`${options.branch}\` is in progress in this
repository and stopped on conflicts. Your job is to finish the merge.

Conflicted files:
${options.conflictedFiles.map((f) => `- ${f}`).join("\n")}

Instructions:
1. Inspect each conflicted file (\`git status\`, \`git diff\`) and resolve the conflict
   markers. Preserve the intent of BOTH sides: the branch's changes and the base's
   changes both belong in the result unless they are genuinely mutually exclusive —
   in that case prefer the base branch's newer conventions and adapt the branch's
   change to them.
2. Watch for semantic conflicts that merge cleanly textually but break the build
   (renamed functions, changed signatures, moved files). Check call sites of
   anything the base renamed or removed.
3. Run the project's typecheck and affected tests if available to verify the result.
4. Stage everything and complete the merge commit with:
   git add -A && git commit --no-edit
5. Do NOT push. Do NOT amend or rebase existing commits. Do NOT abort the merge.

When you are done, every conflict must be resolved and the merge commit created.`;
}

/**
 * Catch one PR branch up with its base, resolving conflicts with the agent
 * when needed.
 *
 * @param prUrl - GitHub PR URL
 * @param options - Push/comment suppression and injected agent runner
 */
export async function resolveConflictsOnPr(
  prUrl: string,
  options: ResolveConflictsOptions = {},
): Promise<ResolveConflictsResult> {
  const { verbose = false, noPush = false, noComment = false, cwd } = options;
  const agentRunner = options.agentRunner ?? runAgent;

  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  console.log(`🔀 Resolving merge conflicts on ${owner}/${repo}#${prNumber}`);

  let githubClient: GitHubReviewsClient | undefined;
  const getClient = () => (githubClient ??= new GitHubReviewsClient());
  const pr = options.fetchPr
    ? await options.fetchPr(owner, repo, prNumber)
    : await getClient().getPullRequest(owner, repo, prNumber);

  if (pr.state !== "open") {
    return { outcome: "skipped", message: `PR is ${pr.state}` };
  }
  const baseRepo = `${owner}/${repo}`;
  if (pr.head.repo && pr.head.repo.full_name !== baseRepo) {
    return {
      outcome: "skipped",
      message: `fork PR (${pr.head.repo.full_name}); conflicts must be resolved by the author`,
    };
  }

  const branch = pr.head.ref;
  const baseRef = pr.base.ref;

  const worktree = await Utils.prepareReviewWorktree(branch, { verbose, cwd });
  if (!worktree.success || !worktree.path) {
    return { outcome: "failed", message: `worktree preparation failed: ${worktree.error}` };
  }
  const workDir = worktree.path;

  // Commit attribution for the merge commit (matches address-review).
  if (!process.env.GITHUB_TOKEN) {
    const appAuth = GitHubAppAuth.fromEnvironment();
    if (appAuth) {
      try {
        const author = await appAuth.getGitAuthor();
        await Utils.executeGitCommand(["config", "user.name", author.name], { cwd: workDir });
        await Utils.executeGitCommand(["config", "user.email", author.email], { cwd: workDir });
      } catch {
        // Local git config applies.
      }
    }
  }

  // A merge needs the common ancestor. Repos can be shallow from CI-style
  // checkouts or from older devintern versions whose review fetch used
  // --depth=1 (which shallows the whole repo); unshallow before merging.
  const shallow = await Utils.executeGitCommand(["rev-parse", "--is-shallow-repository"], {
    cwd: workDir,
  });
  if (shallow.output.trim() === "true") {
    await Utils.executeGitCommand(["fetch", "--unshallow", "origin"], { cwd: workDir, verbose });
  }
  await Utils.executeGitCommand(["fetch", "origin", baseRef], { cwd: workDir, verbose });

  const merge = await Utils.executeGitCommand(["merge", `origin/${baseRef}`, "--no-edit"], {
    cwd: workDir,
    verbose,
  });

  let outcome: "clean" | "resolved";
  if (merge.success) {
    // Includes the already-up-to-date case: nothing to push, nothing to say.
    const status = await Utils.executeGitCommand(["status", "--porcelain"], { cwd: workDir });
    const ahead = await Utils.executeGitCommand(["rev-list", "--count", `origin/${branch}..HEAD`], {
      cwd: workDir,
    });
    if (status.success && status.output.trim() === "" && ahead.output.trim() === "0") {
      return { outcome: "skipped", message: "already up to date with base" };
    }
    outcome = "clean";
    console.log(`✅ origin/${baseRef} merged cleanly`);
  } else {
    const conflicted = await Utils.executeGitCommand(["diff", "--name-only", "--diff-filter=U"], {
      cwd: workDir,
    });
    const conflictedFiles = conflicted.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (conflictedFiles.length === 0) {
      // Merge failed for a non-conflict reason (e.g. dirty tree).
      await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
      return { outcome: "failed", message: `merge failed: ${merge.error}` };
    }

    console.log(`⚔️  ${conflictedFiles.length} conflicted file(s); handing to the agent`);
    const agentResult = await agentRunner(
      buildConflictPrompt({ baseRef, branch, conflictedFiles }),
      workDir,
      verbose,
    );

    // Trust the tree, not the agent's word: nothing may be left unmerged.
    const unmerged = await Utils.executeGitCommand(["diff", "--name-only", "--diff-filter=U"], {
      cwd: workDir,
    });
    const stillConflicted = unmerged.output.trim() !== "";
    const mergeHead = await Utils.executeGitCommand(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: workDir,
    });

    if (!agentResult.success || stillConflicted) {
      await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
      const message = stillConflicted
        ? "agent left unresolved conflicts; merge aborted"
        : "agent run failed; merge aborted";
      if (!noComment) {
        await postOutcomeComment(getClient(), owner, repo, prNumber, false, baseRef, message);
      }
      return { outcome: "failed", message };
    }

    if (mergeHead.success) {
      // Agent resolved but did not commit; finish the merge.
      await Utils.executeGitCommand(["add", "-A"], { cwd: workDir });
      const commit = await Utils.executeGitCommand(["commit", "--no-edit"], { cwd: workDir });
      if (!commit.success) {
        await Utils.executeGitCommand(["merge", "--abort"], { cwd: workDir });
        return { outcome: "failed", message: `merge commit failed: ${commit.error}` };
      }
    }
    outcome = "resolved";
  }

  if (noPush) {
    return { outcome, message: "merge committed (push skipped)" };
  }

  // Never force: a rejected push means a human moved the branch — theirs wins.
  const push = await Utils.pushCurrentBranch({ cwd: workDir, expectedBranch: branch, verbose });
  if (!push.success) {
    return { outcome: "failed", message: `push rejected: ${push.message}` };
  }

  if (!noComment) {
    await postOutcomeComment(getClient(), owner, repo, prNumber, true, baseRef, outcome);
  }
  const message =
    outcome === "clean"
      ? `caught up with ${baseRef} (clean merge)`
      : `conflicts with ${baseRef} resolved and pushed`;
  console.log(`✅ ${message}`);
  return { outcome, message };
}

async function postOutcomeComment(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  prNumber: number,
  success: boolean,
  baseRef: string,
  detail: string,
): Promise<void> {
  const body = success
    ? detail === "clean"
      ? `🔀 Merged \`${baseRef}\` into this branch (no conflicts).`
      : `🔀 This branch had merge conflicts with \`${baseRef}\`; devintern resolved them and pushed the merge. Please double-check the resolution.`
    : `⚠️ devintern attempted to resolve this branch's merge conflicts with \`${baseRef}\` but could not finish safely (${detail}). The merge was aborted; manual resolution needed.`;
  try {
    await client.postPullRequestComment(owner, repo, prNumber, body);
  } catch (error) {
    console.warn(`⚠️  Failed to post conflict-resolution comment: ${(error as Error).message}`);
  }
}
