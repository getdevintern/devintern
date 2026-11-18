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

type Git = (args: string[]) => Promise<{ success: boolean; output: string; error?: string }>;

async function revParse(git: Git, ref: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.success ? result.output.trim() : null;
}

async function isAncestor(git: Git, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", ancestor, descendant])).success;
}

function tail(text: string, lines = 6): string {
  return text.trim().split("\n").slice(-lines).join(" | ");
}

/** {@link StackGit} backed by the git CLI. */
export function createGitStack(options: GitStackOptions): StackGit {
  return {
    async restack({ repo, branch, expectedHeadSha, onto, oldBaseCandidates }) {
      const checkout = await options.checkout(repo);
      const git: Git = (args) =>
        Utils.executeGitCommand(args, {
          cwd: checkout.cwd,
          env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", ...options.env },
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
    if (!mergeBase.success) throw new Error(`no merge base between ${onto} and ${branch}`);
    oldBase = mergeBase.output.trim();
  }

  const rebase = await git(["rebase", "--onto", ontoSha, oldBase]);
  if (!rebase.success) {
    const unmerged = await git(["diff", "--name-only", "--diff-filter=U"]);
    const output = `${rebase.output}\n${rebase.error ?? ""}`;
    await git(["rebase", "--abort"]);
    if (unmerged.output.trim() !== "" || /CONFLICT|could not apply/i.test(output)) {
      return { kind: "conflict", detail: tail(output) };
    }
    throw new Error(`rebase failed: ${tail(output)}`);
  }
  const rebased = await revParse(git, "HEAD");
  if (!rebased) throw new Error("rebase left no HEAD");
  if (rebased === head) return { kind: "up-to-date", baseSha: ontoSha };

  const push = await git([
    "push",
    `--force-with-lease=refs/heads/${branch}:${expectedHeadSha}`,
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!push.success) {
    const output = `${push.output}\n${push.error ?? ""}`;
    if (/stale info|rejected|fetch first|non-fast-forward/i.test(output)) {
      return { kind: "stale", detail: tail(output) };
    }
    throw new Error(`push failed: ${tail(output)}`);
  }
  return { kind: "restacked", headSha: rebased, baseSha: ontoSha };
}
