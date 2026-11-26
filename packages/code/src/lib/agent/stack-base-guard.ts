/**
 * Delivery-side wiring of `dependencies/stack-run.ts`: before a delivery step
 * that reads the stacked base (commit, verify, auto-review, plugins, publish),
 * make sure the base still exists, and move the run to its merge target when
 * it merged mid-run.
 */

import { PRManager } from "../code-host/manager";
import { runContext } from "../cli/context";
import type { StackBase } from "../dependencies/gate";
import { reconcileRunStackBase } from "../dependencies/stack-run";
import type { RunStackDeps } from "../dependencies/stack-run";
import { releaseStackBase } from "../dependencies/stacked-base";
import { Utils } from "../utils";

/** The slice of the delivery state the guard reads and updates. */
export interface StackGuardState {
  context: { stackBase?: StackBase; prTargetBranch: string; enableGit: boolean };
  prTargetBranch: string;
  /** Set when the base closed unmerged (or the move failed): escalate with it. */
  stackBlocked?: string;
}

/** {@link RunStackDeps} for the run's own checkout (`cwd`). */
export function defaultRunStackDeps(cwd: string = process.cwd()): RunStackDeps {
  return {
    getBasePr: (prNumber) => new PRManager().getPullRequestSnapshot(prNumber),
    git: (args, env) =>
      Utils.executeGitCommand(args, {
        cwd,
        env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", ...env },
      }),
    defaultBranch: () => Utils.getMainBranchName(),
  };
}

function branchName(ref: string): string {
  return ref.replace(/^origin\//, "");
}

/**
 * Re-resolve the run's stacked base. A merged base switches the PR target
 * (and the diff base of later verify/auto-review passes) to the branch it
 * merged into and stops claiming the stack; a closed one records
 * `stackBlocked` and halts.
 *
 * @returns A halt when the run cannot deliver, otherwise nothing
 */
export async function ensureStackBase(
  state: StackGuardState,
  deps: RunStackDeps = defaultRunStackDeps(),
): Promise<{ kind: "halt"; reason: string } | void> {
  if (state.stackBlocked) return { kind: "halt", reason: state.stackBlocked };
  const ctx = state.context;
  const base = ctx.stackBase;
  if (!base || !ctx.enableGit || branchName(ctx.prTargetBranch) !== base.branch) return;
  const result = await reconcileRunStackBase(base, deps);
  if (result.kind === "unchanged") return;
  if (result.kind === "blocked") {
    state.stackBlocked = result.reason;
    if (runContext.activeTaskContext) runContext.activeTaskContext.stackBlocked = result.reason;
    console.warn(`⛔ ${result.reason}`);
    return { kind: "halt", reason: result.reason };
  }
  ctx.prTargetBranch = result.target;
  state.prTargetBranch = result.target;
  releaseStackBase();
}

/**
 * Error for a diff whose stacked base branch is missing on the remote, naming
 * the parent and the way out (instead of git's bare "not found").
 */
export function describeMissingStackBase(base: StackBase, error: Error): Error {
  return new Error(
    `${error.message} This run is stacked on ${base.taskKey} PR #${base.prNumber} ` +
      `(branch '${base.branch}'), which was merged, closed, or deleted mid-run and could not be ` +
      `re-resolved. Check that PR, then re-run this task; it continues from the preserved branch.`,
  );
}
