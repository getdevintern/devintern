/**
 * Deterministic restack of a stacked branch with plain git (no agent):
 *
 *   git rebase --onto origin/<new base> <old base tip> <stacked branch>
 *   git push --force-with-lease=<branch>:<expected head>
 *
 * The rebase runs on a detached HEAD in a checkout the caller provides
 * (fleet mode: a disposable worktree of the repo's bare clone), so the branch
 * is never checked out and no other worktree's branch is touched. A conflict
 * aborts the rebase and pushes nothing.
 */

import { Utils } from "../utils";
import type { RestackResult, StackGit } from "./stack-maintainer";

/** A checkout to restack in, fetched from `origin`, plus its cleanup. */
export interface RestackCheckout {
  cwd: string;
  release(): Promise<void>;
}

export interface GitStackOptions {
  /** Provide a checkout of `repo` whose `origin/*` refs are freshly fetched. */
  checkout(repo: string): Promise<RestackCheckout>;
  /** Extra environment for git (tests pin identity). */
  env?: NodeJS.ProcessEnv;
}

export type Git = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ success: boolean; output: string; error?: string }>;

async function revParse(git: Git, ref: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.success ? result.output.trim() : null;
}

async function isAncestor(git: Git, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", ancestor, descendant])).success;
}

function tail(text: string, lines = 6): string {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^hint:/i.test(line.trim()))
    .slice(-lines)
    .join(" | ");
}

/**
 * Committer identity for the rebase. The restack checkout is a worktree of a
 * bare clone that nothing configures an identity on, so on a host without a
 * global `user.name`/`user.email` git refuses to commit ("Please tell me who
 * you are"). When no identity resolves, reuse the committer of the branch tip
 * (the identity the task run committed with, e.g. the GitHub App bot); rebase
 * keeps each commit's author either way.
 */
export async function committerEnv(git: Git, head: string): Promise<NodeJS.ProcessEnv | undefined> {
  if ((await git(["var", "GIT_COMMITTER_IDENT"])).success) return undefined;
  const ident = await git(["log", "-1", "--format=%cn%x00%ce", head]);
  const [name = "", email = ""] = ident.success ? ident.output.trim().split("\0") : [];
  if (name === "" || email === "") return undefined;
  return { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** Outcome of {@link rebaseOntoBase}. */
export type RebaseOntoResult =
  | { kind: "rebased"; headSha: string; baseSha: string }
  | { kind: "up-to-date"; baseSha: string }
  | { kind: "conflict"; detail: string };

/**
 * Rebase the checked-out `HEAD` (`head`) onto `ontoSha`, dropping every commit
 * reachable from the first of `oldBaseCandidates` the branch contains (falling
 * back to the merge base with `onto`). A conflict aborts the rebase and leaves
 * `HEAD` where it was. Shared by the stack maintainer's restack (on a detached
 * checkout) and a stacked run whose base merged mid-run (on its own branch,
 * with `autostash` so uncommitted work survives).
 */
export async function rebaseOntoBase(
  git: Git,
  input: {
    head: string;
    ontoSha: string;
    /** Branch name of `ontoSha`, for messages. */
    onto: string;
    oldBaseCandidates: readonly string[];
    autostash?: boolean;
  },
): Promise<RebaseOntoResult> {
  const { head, ontoSha, onto } = input;
  if (await isAncestor(git, ontoSha, head)) return { kind: "up-to-date", baseSha: ontoSha };

  // Strip everything up to the base tip the branch was built on; the merge
  // base is the fallback when no recorded tip is in the branch's history.
  let oldBase: string | undefined;
  for (const candidate of input.oldBaseCandidates) {
    const sha = await revParse(git, candidate);
    if (sha && (await isAncestor(git, sha, head))) {
      oldBase = sha;
      break;
    }
  }
  if (!oldBase) {
    const mergeBase = await git(["merge-base", ontoSha, head]);
    if (!mergeBase.success) throw new Error(`no merge base between ${onto} and ${head}`);
    oldBase = mergeBase.output.trim();
  }

  const rebase = await git(
    ["rebase", ...(input.autostash ? ["--autostash"] : []), "--onto", ontoSha, oldBase],
    await committerEnv(git, head),
  );
  const unmerged = async () =>
    (await git(["diff", "--name-only", "--diff-filter=U"])).output.trim() !== "";
  if (!rebase.success) {
    const conflicted = await unmerged();
    const output = `${rebase.output}\n${rebase.error ?? ""}`;
    await git(["rebase", "--abort"]);
    if (conflicted || /CONFLICT|could not apply/i.test(output)) {
      return { kind: "conflict", detail: tail(output) };
    }
    // An untracked file at a path `onto` adds stops git before it detaches
    // HEAD (the autostash leaves untracked files in place), so nothing moved;
    // only a person can decide which copy wins.
    if (/untracked working tree files would be overwritten/i.test(output)) {
      return {
        kind: "conflict",
        detail: `untracked files would be overwritten by ${onto}: ${tail(output)}`,
      };
    }
    throw new Error(`rebase failed: ${tail(output)}`);
  }
  // The rebase itself applied, but re-applying the autostash conflicted: git
  // left HEAD on the new base, conflict markers in the tree, and the changes
  // in `refs/stash`. Undo the rebase and pop the stash onto the head it was
  // taken from (which applies cleanly), so a conflict always leaves `HEAD`
  // and the working tree as they were.
  if (input.autostash && (await unmerged())) {
    return restoreAfterStashConflict(git, head, onto);
  }
  const rebased = await revParse(git, "HEAD");
  if (!rebased) throw new Error("rebase left no HEAD");
  if (rebased === head) return { kind: "up-to-date", baseSha: ontoSha };
  return { kind: "rebased", headSha: rebased, baseSha: ontoSha };
}

async function restoreAfterStashConflict(
  git: Git,
  head: string,
  onto: string,
): Promise<RebaseOntoResult> {
  const stash = await revParse(git, "refs/stash");
  await git(["reset", "--hard", "--quiet", head]);
  const pop = await git(["stash", "pop", "--quiet"]);
  if (pop.success && !(await git(["diff", "--name-only", "--diff-filter=U"])).output.trim()) {
    return {
      kind: "conflict",
      detail: `re-applying uncommitted changes onto ${onto} conflicted; the branch was left on its original base`,
    };
  }
  // Should not happen (the stash was taken from `head`); leave a clean tree
  // so nothing commits conflict markers, and name the stash holding the work.
  await git(["reset", "--hard", "--quiet", head]);
  return {
    kind: "conflict",
    detail:
      `re-applying uncommitted changes onto ${onto} conflicted and they could not be restored; ` +
      `they are in git stash ${stash ? stash.slice(0, 12) : "refs/stash"} (\`git stash list\`)`,
  };
}

/** {@link StackGit} backed by the git CLI. */
export function createGitStack(options: GitStackOptions): StackGit {
  return {
    async restack({ repo, branch, expectedHeadSha, onto, oldBaseCandidates }) {
      const checkout = await options.checkout(repo);
      const git: Git = (args, env) =>
        Utils.executeGitCommand(args, {
          cwd: checkout.cwd,
          env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", ...options.env, ...env },
        });
      try {
        return await restackIn(git, { branch, expectedHeadSha, onto, oldBaseCandidates });
      } finally {
        await checkout.release();
      }
    },
  };
}

async function restackIn(
  git: Git,
  input: { branch: string; expectedHeadSha: string; onto: string; oldBaseCandidates: string[] },
): Promise<RestackResult> {
  const { branch, expectedHeadSha, onto } = input;
  const head = await revParse(git, `refs/remotes/origin/${branch}`);
  if (head !== expectedHeadSha) {
    return {
      kind: "stale",
      detail: `origin/${branch} is ${head ?? "missing"}, expected ${expectedHeadSha}`,
    };
  }
  const ontoSha = await revParse(git, `refs/remotes/origin/${onto}`);
  if (!ontoSha) throw new Error(`origin/${onto} not found`);
  const checkout = await git(["checkout", "--force", "--detach", head]);
  if (!checkout.success) throw new Error(`checkout ${head}: ${checkout.error ?? checkout.output}`);
  const rebase = await rebaseOntoBase(git, {
    head,
    ontoSha,
    onto,
    oldBaseCandidates: input.oldBaseCandidates,
  });
  if (rebase.kind !== "rebased") return rebase;
  const rebased = rebase.headSha;

  const push = await git([
    "push",
    `--force-with-lease=refs/heads/${branch}:${expectedHeadSha}`,
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!push.success) {
    const output = `${push.output}\n${push.error ?? ""}`;
    // `[remote rejected]` is the server refusing the update (pre-receive hook,
    // branch protection, a token without the `workflows` scope): retrying
    // pushes the same refusal. Only a lease or race failure is stale.
    if (/\[remote rejected\]/i.test(output)) {
      return { kind: "push-rejected", detail: tail(output) };
    }
    if (/stale info|fetch first|non-fast-forward/i.test(output)) {
      return { kind: "stale", detail: tail(output) };
    }
    throw new Error(`push failed: ${tail(output)}`);
  }
  return { kind: "restacked", headSha: rebased, baseSha: ontoSha };
}
