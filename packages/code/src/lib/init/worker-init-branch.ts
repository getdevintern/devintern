/**
 * The workspace step's `[[repos]].default_branch` handling for
 * `devintern worker init`: record the branch task worktrees are cut from and
 * worker task pull requests target, asking the wizard only when the checkout
 * branch differs from the remote default.
 */

import { MAX_PROMPT_ATTEMPTS, createPromptAttempts } from "@devintern/task-trackers";
import { detectCheckoutBranches, remoteTrackingBranchExists } from "../workspace/checkout-branches";
import { loadWorkspaceConfig } from "../workspace/config";
import { clearRepoDefaultBranch, writeRepoDefaultBranch } from "../workspace/init";
import { workspaceConfigPath } from "../workspace/paths";
import type { PromptRun } from "./worker-init-run";

/**
 * Record `[[repos]].default_branch`: the base task worktrees are cut from and
 * worker task pull requests target. A branch is only offered or kept when it
 * exists on origin, because worktrees come from `origin/<branch>`. When the
 * checkout is on the remote's default branch it is saved silently; otherwise
 * the wizard asks, offering the saved value (or the remote default) on Enter so
 * a re-run keeps the earlier verified answer.
 */
export async function recordRepoDefaultBranch(
  run: PromptRun,
  workspaceDir: string,
  repoName: string,
): Promise<void> {
  const { branch, defaultBranch } = await detectCheckoutBranches(run.cwd);
  if (!branch && !defaultBranch) return;
  const saved = loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).repos.find(
    (repo) => repo.name === repoName,
  )?.defaultBranch;
  const currentOnOrigin = branch ? await remoteTrackingBranchExists(run.cwd, branch) : false;
  const savedOnOrigin = saved ? await remoteTrackingBranchExists(run.cwd, saved) : false;
  if (saved && !savedOnOrigin) {
    run.log(`⚠️  Saved default_branch "${saved}" is not on origin; choosing another branch.`);
  }

  if (!defaultBranch) {
    if (!savedOnOrigin) {
      if (saved) clearRepoDefaultBranch(workspaceDir, repoName);
      run.log(
        "ℹ️  This clone has no origin/HEAD, so default_branch stays unset; " +
          "the worker follows the remote's default branch.",
      );
    }
    return;
  }

  if (branch && branch !== defaultBranch) {
    if (currentOnOrigin) {
      const chosen = await promptRepoDefaultBranch(run, {
        current: branch,
        remote: defaultBranch,
        ...(savedOnOrigin ? { saved } : {}),
      });
      if (chosen !== saved) {
        writeRepoDefaultBranch(workspaceDir, repoName, chosen);
        run.log(`💾 Wrote default_branch = "${chosen}" to workspace.toml`);
      }
      return;
    }
    run.log(
      `⚠️  The checkout is on "${branch}", but that branch is not on origin; ` +
        `using "${savedOnOrigin ? saved : defaultBranch}" instead.`,
    );
  }

  const chosen = savedOnOrigin ? saved : defaultBranch;
  if (!chosen || chosen === saved) return;
  writeRepoDefaultBranch(workspaceDir, repoName, chosen);
  run.log(`💾 Wrote default_branch = "${chosen}" to workspace.toml`);
}

/** Ask which branch task worktrees and PRs use; Enter keeps the saved or remote default. */
async function promptRepoDefaultBranch(
  run: PromptRun,
  ctx: { current: string; remote: string; saved?: string },
): Promise<string> {
  const fallback = ctx.saved ?? ctx.remote;
  const choices = [ctx.current, ctx.remote];
  const reject = createPromptAttempts("default branch");
  for (;;) {
    const answer = (
      await run.prompt(`Base tasks and PRs on ${choices.join(" or ")}? [${fallback}]: `)
    ).trim();
    if (!answer) return fallback;
    if (choices.includes(answer)) return answer;
    if (answer.toLowerCase() === "current") return ctx.current;
    if (answer.toLowerCase() === "default") return ctx.remote;
    if (answer === ctx.saved) return answer;
    run.log(`   Enter ${choices.join(" or ")}, or press Enter for ${fallback}.`);
    reject(
      `No valid default branch after ${MAX_PROMPT_ATTEMPTS} attempts; enter ${choices.join(" or ")}`,
    );
  }
}
