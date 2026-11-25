/**
 * Never discard finished work: when a worker run fails or escalates after the
 * implementation stage, the worker removes (escalated, exit 0) or eventually
 * sweeps its disposable worktree. Whatever the run produced is saved first:
 *
 * 1. Uncommitted changes are committed to the task branch as a WIP commit
 *    naming the run (`--no-verify`: hooks and deny patterns are review
 *    concerns, not a reason to drop work; `.gitignore` still applies).
 * 2. Commits not on `origin` are pushed to the same branch name, so a re-run
 *    (`devintern worker add --resume <taskKey>`, a dashboard retry) continues
 *    from it through session pickup. The push is never forced: a branch
 *    someone else moved is left alone.
 * 3. When the commit or push fails, the worktree is marked to be kept
 *    (`utils/worktree-keep.ts`) and its path is reported instead.
 */

import { isWorkerTaskProcess, runContext } from "../cli/context";
import { committerEnv } from "../dependencies/stack-git";
import type { Git } from "../dependencies/stack-git";
import { getActiveRunContext, hasRunStage } from "../state/run-recorder";
import { finishTaskRun } from "../state/task-run";
import { Utils } from "../utils";
import { markWorktreeKept } from "../utils/worktree-keep";

/** What {@link preserveUnfinishedWork} did. */
export type PreservedWork =
  /** Nothing to save: clean tree and every commit already on `origin`. */
  | { kind: "none"; note?: undefined }
  /** Saved and pushed to `branch`. */
  | { kind: "pushed"; branch: string; committed: boolean; note: string }
  /** Could not push; the worktree at `path` is kept instead. */
  | { kind: "kept"; path: string; detail: string; note: string };

export interface PreserveWorkInput {
  taskKey: string;
  runId?: number;
  /** Whether `worker add --resume` applies (ad-hoc tasks), for the note. */
  resumable?: boolean;
  /** The run's checkout (default: cwd). */
  cwd?: string;
  /** Git in `cwd` (tests). */
  git?: Git;
}

function tail(text: string): string {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^hint:/i.test(line.trim()))
    .slice(-3)
    .join(" | ");
}

/** Identity for the WIP commit when git has none configured. */
async function identityEnv(git: Git): Promise<NodeJS.ProcessEnv | undefined> {
  const committer = await committerEnv(git, "HEAD");
  if (committer) {
    return {
      ...committer,
      GIT_AUTHOR_NAME: committer.GIT_COMMITTER_NAME,
      GIT_AUTHOR_EMAIL: committer.GIT_COMMITTER_EMAIL,
    };
  }
  if ((await git(["var", "GIT_COMMITTER_IDENT"])).success) return undefined;
  return {
    GIT_AUTHOR_NAME: "DevIntern",
    GIT_AUTHOR_EMAIL: "devintern@localhost",
    GIT_COMMITTER_NAME: "DevIntern",
    GIT_COMMITTER_EMAIL: "devintern@localhost",
  };
}

/**
 * Save the run's unfinished work (see the module comment). Best-effort: never
 * throws for git failures, reporting them through a kept worktree instead.
 */
export async function preserveUnfinishedWork(input: PreserveWorkInput): Promise<PreservedWork> {
  const cwd = input.cwd ?? process.cwd();
  const git: Git =
    input.git ??
    ((args, env) =>
      Utils.executeGitCommand(args, {
        cwd,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", ...env },
      }));
  const keep = async (detail: string): Promise<PreservedWork> => {
    await markWorktreeKept(cwd, detail);
    console.warn(`⚠️  Keeping the worktree with this run's unsaved work: ${cwd} (${detail})`);
    return {
      kind: "kept",
      path: cwd,
      detail,
      note: `unsaved work kept in worktree ${cwd} (${detail})`,
    };
  };

  const branch = (await git(["branch", "--show-current"])).output.trim();
  // A detached HEAD or an integration branch is not this task's branch: the
  // run never got to create it, so there is no task work to save.
  if (!branch || (await Utils.isProtectedBranch(branch, cwd))) return { kind: "none" };

  const status = await git(["status", "--porcelain"]);
  if (!status.success) return keep(`git status failed: ${tail(status.error ?? status.output)}`);
  let committed = false;
  if (status.output.trim() !== "") {
    const add = await git(["add", "-A"]);
    const message = `wip(${input.taskKey}): preserve unfinished work${
      input.runId === undefined ? "" : ` from run #${input.runId}`
    }`;
    const commit = add.success
      ? await git(
          [
            "commit",
            "--no-verify",
            "-m",
            message,
            "-m",
            "Saved by DevIntern because the run stopped before delivering. Not reviewed.",
          ],
          await identityEnv(git),
        )
      : add;
    if (!commit.success) {
      return keep(`could not commit: ${tail(commit.error || commit.output)}`);
    }
    committed = true;
    console.log(`💾 Committed unfinished work on '${branch}' (${message})`);
  }

  const unpushed = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  if (unpushed.success && unpushed.output.trim() === "0") return { kind: "none" };

  const push = await git(["push", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]);
  if (!push.success) {
    return keep(`push of '${branch}' failed: ${tail(`${push.output}\n${push.error ?? ""}`)}`);
  }
  console.log(`📤 Pushed unfinished work to '${branch}' so a re-run continues from it`);
  const resume = input.resumable
    ? `; continue with \`devintern worker add --resume ${input.taskKey}\``
    : "; a re-run continues from it";
  return {
    kind: "pushed",
    branch,
    committed,
    note: `work preserved on branch '${branch}'${resume}`,
  };
}

/**
 * End a run that did not succeed, first saving any work its worktree still
 * holds (see {@link preserveUnfinishedWork}) and naming where it went in the
 * outcome reason so the dashboard shows it. Only worker task processes, whose
 * worktree is removed after the run, and only after implementation started.
 */
export async function finishUnfinishedRun(
  status: "escalated" | "failed",
  reason: string,
): Promise<void> {
  let note: string | undefined;
  if (runContext.options?.git && isWorkerTaskProcess() && hasRunStage("implementation")) {
    try {
      const run = getActiveRunContext();
      const preserved = await preserveUnfinishedWork({
        taskKey: run?.taskKey ?? runContext.activeTaskContext?.taskKey ?? "task",
        runId: run?.id,
        resumable: run?.origin === "local",
      });
      note = preserved.note;
    } catch (error) {
      console.warn(`⚠️  Could not preserve unfinished work: ${(error as Error).message}`);
    }
  }
  await finishTaskRun(status, note ? `${reason}; ${note}` : reason);
}
