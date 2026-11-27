/**
 * Git branch facts used when recording `[[repos]].default_branch`: the
 * checkout's current branch and the remote default branch the clone recorded
 * in `origin/HEAD`.
 */

import { Utils } from "../utils";

/**
 * The checkout's current branch and the remote default branch as the clone
 * recorded it (`origin/HEAD`), without contacting the remote. `defaultBranch`
 * stays undefined when the clone has no `origin/HEAD`; the checkout branch is
 * not evidence that the remote has it, and saving an unpushed branch makes
 * `origin/<branch>` worktree creation fail.
 *
 * @param cwd - Repository checkout
 */
export async function detectCheckoutBranches(
  cwd: string,
): Promise<{ branch?: string; defaultBranch?: string }> {
  const head = await Utils.executeGitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
  });
  const branch = head.success ? head.output.trim() || undefined : undefined;
  const originHead = await Utils.executeGitCommand(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  const defaultBranch = originHead.success
    ? originHead.output.trim().replace(/^origin\//, "") || undefined
    : undefined;
  return { branch, defaultBranch };
}

/**
 * Whether `branch` exists on origin as this checkout last fetched it. Worktrees
 * are created from `origin/<branch>`, so a branch without this ref is not safe
 * to record as `default_branch`.
 *
 * @param cwd - Repository checkout
 * @param branch - Branch name without the `origin/` prefix
 */
export async function remoteTrackingBranchExists(cwd: string, branch: string): Promise<boolean> {
  return Utils.gitRefExists(`refs/remotes/origin/${branch}`, { cwd });
}
