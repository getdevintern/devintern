/**
 * Never discard finished work: when a worker run fails or escalates after the
 * implementation stage, the worker removes (escalated, exit 0) or eventually
 * sweeps its disposable worktree. Whatever the run produced is saved first:
 *
 * 1. Uncommitted changes are committed to the task branch as a WIP commit
 *    naming the run. Git hooks run as for any commit (a secret scanner in a
 *    pre-commit hook still applies); `.gitignore` applies too.
 * 2. Commits not on `origin` are pushed to the same branch name, so a re-run
 *    (`devintern worker add --resume <taskKey>`, a dashboard retry) continues
 *    from it through session pickup. Pre-push hooks run, and the push is never
 *    forced: a branch someone else moved is left alone.
 * 3. When the tree has unresolved conflicts, or the commit or push fails
 *    (including a hook rejecting it), nothing more is published: the worktree
 *    is marked to be kept (`utils/worktree-keep.ts`) and its path is reported.
 * 4. `DEVINTERN_PUSH_UNFINISHED_WORK=0` skips steps 1-2: any unsaved work is
 *    left uncommitted in a kept worktree and nothing leaves the machine.
 * 5. A branch that may already back an open change request (the agent ran
 *    `gh pr create`, or a step after publish failed) is never pushed to: the
 *    WIP commit would land on the PR unreviewed and trigger its CI. The push
 *    only happens when the branch is not on `origin` yet, or the code host
 *    confirms it has no open PR; otherwise the WIP stays committed in a kept
 *    worktree.
 * 6. Secret-looking new or changed files (`.env*` other than templates, keys,
 *    certificates) are never committed: they stay uncommitted in a kept
 *    worktree. The outcome note lists the committed paths for auditing.
 *
 * Only real work is saved: untracked sandbox placeholders are skipped exactly
 * as the delivery commit skips them (`utils/git-stage.ts`).
 */

import { isWorkerTaskProcess, runContext } from "../cli/context";
import { committerEnv } from "../dependencies/stack-git";
import type { Git } from "../dependencies/stack-git";
import { getActiveRunContext, hasRunStage } from "../state/run-recorder";
import { finishTaskRun } from "../state/task-run";
import { Utils } from "../utils";
import { hasUncommittedWork, stageWorkTreeChanges } from "../utils/git-stage";
import { markWorktreeKept } from "../utils/worktree-keep";
import { PRManager } from "../code-host/manager";

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
  /**
   * Change request state of `branch` on the code host: `undefined` when it
   * cannot be checked. Consulted only when the branch is already on `origin`.
   * Default: unknown, so such a branch is not pushed to.
   */
  changeRequestState?: (branch: string) => Promise<"open" | "closed" | "none" | undefined>;
}

/** Templates are committed on purpose; anything else under these names is a secret. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_FILE =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx)|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|service-account.*\.json)$/i;

/** Whether `path` (repo-relative) names a file that commonly holds credentials. */
export function isSecretLikePath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return SECRET_FILE.test(name) && !ENV_TEMPLATE.test(name);
}

/** `a, b, c (+N more)` for an outcome note. */
function listPaths(paths: string[], max = 5): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} (+${paths.length - max} more)` : shown;
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

/** Result of {@link commitUnfinished}: what went into the WIP commit, or why it failed. */
type WipCommit =
  | { committedPaths: string[]; withheld: string[]; message?: string }
  | { error: string };

/**
 * Stage the worktree's real work, unstage secret-like paths, and commit the
 * rest as the WIP commit. Nothing is committed when only secrets changed.
 */
async function commitUnfinished(
  git: Git,
  cwd: string,
  input: PreserveWorkInput,
): Promise<WipCommit> {
  const staged = stageWorkTreeChanges(cwd);
  if (!staged.success) return { error: tail(staged.error ?? "staging failed") };
  const listed = await git(["diff", "--cached", "--name-only", "-z"]);
  if (!listed.success) return { error: tail(listed.error || "could not list staged files") };
  const paths = listed.output.split("\0").filter((path) => path !== "");
  const withheld = paths.filter(isSecretLikePath);
  const committedPaths = paths.filter((path) => !isSecretLikePath(path));
  if (withheld.length > 0) {
    const unstage = await git(["--literal-pathspecs", "reset", "--quiet", "--", ...withheld]);
    if (!unstage.success) return { error: tail(unstage.error || unstage.output) };
  }
  if (committedPaths.length === 0) return { committedPaths, withheld };

  const message = `wip(${input.taskKey}): preserve unfinished work${
    input.runId === undefined ? "" : ` from run #${input.runId}`
  }`;
  const commit = await git(
    [
      "commit",
      "-m",
      message,
      "-m",
      "Saved by DevIntern because the run stopped before delivering. Not reviewed.",
    ],
    await identityEnv(git),
  );
  if (!commit.success) return { error: tail(commit.error || commit.output) };
  return { committedPaths, withheld, message };
}

/**
 * Why the WIP must not be pushed to `branch`, or `undefined` when it may be:
 * a branch already on `origin` may back an open PR (agent `gh pr create`, or a
 * failure after publish), so it is pushed only when the host confirms none.
 */
async function pushBlocker(
  git: Git,
  branch: string,
  changeRequestState: PreserveWorkInput["changeRequestState"],
): Promise<string | undefined> {
  const remote = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  if (remote.success && remote.output.trim() === "") return undefined;
  let state: "open" | "closed" | "none" | undefined;
  try {
    state = await changeRequestState?.(branch);
  } catch {
    state = undefined;
  }
  if (state === "none" || state === "closed") return undefined;
  return state === "open"
    ? `'${branch}' has an open pull request; WIP not pushed onto it`
    : `could not confirm '${branch}' has no open pull request; WIP not pushed`;
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

  // Sandbox placeholders (the empty `.bashrc`, `.claude/*`, ... files a
  // `/dev/null` mount point leaves behind) are not work: count and stage
  // exactly what the normal delivery commit would (`utils/git-stage.ts`).
  const work = hasUncommittedWork(cwd);
  if (!work.success) return keep(`git status failed: ${tail(work.error ?? "")}`);
  // Committing unmerged paths would save conflict markers as the work.
  const unmerged = await git(["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.output.trim() !== "") {
    return keep(`unresolved conflicts in ${unmerged.output.trim().split("\n").join(", ")}`);
  }
  const unpushedCount = async () => {
    const unpushed = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
    return unpushed.success ? unpushed.output.trim() : undefined;
  };

  // Opt-out: never publish an unfinished run's output; keep it locally.
  if (process.env.DEVINTERN_PUSH_UNFINISHED_WORK === "0") {
    if (!work.dirty && (await unpushedCount()) === "0") return { kind: "none" };
    return keep("DEVINTERN_PUSH_UNFINISHED_WORK=0");
  }

  const wip = work.dirty
    ? await commitUnfinished(git, cwd, input)
    : { committedPaths: [], withheld: [] };
  if ("error" in wip) return keep(`could not commit: ${wip.error}`);
  const { committedPaths, withheld } = wip;
  const committed = committedPaths.length > 0;
  if (committed) console.log(`💾 Committed unfinished work on '${branch}' (${wip.message})`);
  const committedNote = committed
    ? ` (committed ${committedPaths.length} file${committedPaths.length === 1 ? "" : "s"}: ${listPaths(committedPaths)})`
    : "";
  const withheldDetail =
    withheld.length > 0 ? `secret-like files not committed: ${listPaths(withheld)}` : undefined;

  if ((await unpushedCount()) === "0") {
    return withheldDetail ? keep(withheldDetail) : { kind: "none" };
  }

  const blocked = await pushBlocker(git, branch, input.changeRequestState);
  if (blocked) {
    return keep([blocked + committedNote, withheldDetail].filter(Boolean).join("; "));
  }

  const push = await git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  if (!push.success) {
    return keep(
      [`push of '${branch}' failed: ${tail(`${push.output}\n${push.error ?? ""}`)}`, withheldDetail]
        .filter(Boolean)
        .join("; "),
    );
  }
  console.log(`📤 Pushed unfinished work to '${branch}' so a re-run continues from it`);
  const resume = input.resumable
    ? `; continue with \`devintern worker add --resume ${input.taskKey}\``
    : "; a re-run continues from it";
  let keptNote = "";
  if (withheldDetail) {
    await markWorktreeKept(cwd, withheldDetail);
    keptNote = `; ${withheldDetail}, left in kept worktree ${cwd}`;
  }
  return {
    kind: "pushed",
    branch,
    committed,
    note: `work preserved on branch '${branch}'${committedNote}${resume}${keptNote}`,
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
        changeRequestState: (branch) => new PRManager().getChangeRequestState(branch),
      });
      note = preserved.note;
    } catch (error) {
      console.warn(`⚠️  Could not preserve unfinished work: ${(error as Error).message}`);
    }
  }
  await finishTaskRun(status, note ? `${reason}; ${note}` : reason);
}
