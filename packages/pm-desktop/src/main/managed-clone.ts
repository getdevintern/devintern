/**
 * App-owned GitHub checkouts under `<userData>/projects/<owner>-<repo>-<id>/`.
 *
 * One managed clone per connected remote (canonical slug). Missing dirs are
 * re-cloned; "Open existing folder" paths are never migrated here.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  formatGitHubRepoLabel,
  githubHttpsRemoteUrl,
  parseGitHubRepoInput,
} from "../shared/github-repo.ts";
import type { GitHubRepoRef } from "../shared/github-repo.ts";
import type { ProjectBinding } from "../shared/project-binding.ts";
import { probeGitHubRepo } from "./github-api.ts";
import { getGitHubToken } from "./github-auth.ts";
import { authenticatedGitExec } from "./git-auth.ts";
import {
  inspectWorkingTreeDirtiness,
  isWouldOverwriteMergeFailure,
  softDirtyOverwriteMessage,
  defaultGitExec,
} from "./git-sync.ts";
import type { GitExec } from "./git-sync.ts";
import {
  findManagedBindingByRemote,
  rememberProjectBinding,
  touchProjectBindingLastFetch,
  upsertProjectBinding,
} from "./project-bindings.ts";

/** Test-only override for the projects root. */
let projectsRootForTests: string | undefined;
let gitExecForTests: GitExec | undefined;

/** @internal Isolate managed clone I/O in tests. */
export function setManagedProjectsRootForTests(dir: string | undefined): void {
  projectsRootForTests = dir;
}

/** @internal Override git runner in tests. */
export function setManagedCloneGitExecForTests(exec: GitExec | undefined): void {
  gitExecForTests = exec;
}

async function projectsRoot(): Promise<string> {
  if (projectsRootForTests !== undefined) return projectsRootForTests;
  const { app } = await import("electron");
  return join(app.getPath("userData"), "projects");
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/** Directory basename: `<owner>-<repo>-<id>`. */
export function managedCloneDirName(ref: GitHubRepoRef, id: string): string {
  return `${sanitizeSegment(ref.owner)}-${sanitizeSegment(ref.repo)}-${id}`;
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function git(): GitExec {
  return gitExecForTests ?? authenticatedGitExec;
}

async function pathExists(path: string): Promise<boolean> {
  return existsSync(path);
}

/**
 * GitHub-compatible branch names. Rejects leading `-` (git flag injection via
 * positionals) and other unsafe ref shapes.
 */
const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isSafeBranchName(branch: string): boolean {
  return (
    SAFE_BRANCH_RE.test(branch) &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.includes("//")
  );
}

/** @internal Validate a user-supplied branch before passing it to git. */
export function assertSafeBranchName(branch: string): void {
  if (!isSafeBranchName(branch)) {
    throw Object.assign(
      new Error(
        `Invalid branch name "${branch}". Use letters, numbers, and . _ / - (no leading dash).`,
      ),
      { code: "invalid_input" },
    );
  }
}

/**
 * Ensure a managed clone exists for `repoInput`, returning the binding.
 * Reuses an existing managed binding for the same remote when present.
 */
export async function connectManagedGitHubRepo(options: {
  repoInput: string;
  branch?: string;
}): Promise<ProjectBinding> {
  const ref = parseGitHubRepoInput(options.repoInput);
  if (!ref) {
    throw new Error("Enter a GitHub repository as owner/repo (or paste a github.com URL).");
  }

  const token = await getGitHubToken();
  const probe = await probeGitHubRepo(ref, token);
  if (!probe.ok) {
    const err = new Error(probe.message) as Error & { code?: string };
    err.code = probe.code;
    throw err;
  }

  // Only an explicitly requested branch switches an existing checkout.
  // probe.defaultBranch is for first-time / re-clone when none was supplied.
  const requestedBranch = options.branch?.trim() || undefined;
  if (requestedBranch) {
    assertSafeBranchName(requestedBranch);
  }
  const defaultBranch =
    probe.defaultBranch.length > 0 && isSafeBranchName(probe.defaultBranch)
      ? probe.defaultBranch
      : undefined;

  const existing = await findManagedBindingByRemote(ref.slug);
  if (existing) {
    const stillThere = await pathExists(join(existing.localPath, ".git"));
    if (stillThere) {
      if (requestedBranch) {
        await ensureOnBranch(existing.localPath, requestedBranch);
      }
      const updated = await upsertProjectBinding({
        ...existing,
        remote: ref.slug,
        branch: requestedBranch ?? existing.branch,
        managed: true,
      });
      return updated;
    }
    // Managed dir missing → re-clone into the same path (reuse id).
    const branchForClone = requestedBranch ?? defaultBranch;
    await cloneInto(existing.localPath, ref, branchForClone);
    const restored = await upsertProjectBinding({
      ...existing,
      remote: ref.slug,
      branch: branchForClone,
      managed: true,
      lastFetch: Date.now(),
    });
    return restored;
  }

  const branchForClone = requestedBranch ?? defaultBranch;
  const id = shortId();
  const root = await projectsRoot();
  await mkdir(root, { recursive: true });
  const localPath = join(root, managedCloneDirName(ref, id));
  await cloneInto(localPath, ref, branchForClone);

  const binding: ProjectBinding = {
    id,
    remote: ref.slug,
    localPath,
    branch: branchForClone,
    lastFetch: Date.now(),
    managed: true,
  };
  await rememberProjectBinding(binding);
  return binding;
}

async function cloneInto(
  localPath: string,
  ref: GitHubRepoRef,
  branch: string | undefined,
): Promise<void> {
  const root = await projectsRoot();
  const resolved = resolve(localPath);
  // Same guard as deleteManagedCloneDir — never rm/clone outside userData/projects.
  if (!isStrictSubpathOf(resolved, root)) {
    throw new Error("Refusing to clone into a path outside the managed projects directory.");
  }

  // Clean partial leftovers from a previous failed clone.
  if (await pathExists(resolved)) {
    await rm(resolved, { recursive: true, force: true });
  }
  await mkdir(resolved, { recursive: true });
  // Clone into the empty directory (`.`).
  const remote = githubHttpsRemoteUrl(ref.owner, ref.repo);
  const args = ["clone", "--recurse-submodules"];
  if (branch) {
    args.push("--branch", branch, "--single-branch");
  }
  args.push(remote, ".");

  const result = await git()(resolved, args);

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    const isAuthError = /Authentication failed|could not read Username|403|401/i.test(detail);

    // An OAuth (ghu_) token from a GitHub App that isn't installed on the repo
    // is rejected by git even though the API probe succeeded. Retry without
    // auth — public repos clone anonymously, and private repos will fail again
    // with a clear auth error.
    if (isAuthError) {
      const retry = await defaultGitExec(resolved, args);
      if (retry.code === 0) {
        return;
      }
      const retryDetail = (retry.stderr || retry.stdout).trim();
      await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
      if (/Authentication failed|could not read Username|403|401/i.test(retryDetail)) {
        throw Object.assign(
          new Error(
            "GitHub authentication failed while cloning. Connect a token with access to this repository.",
          ),
          { code: "auth_required" },
        );
      }
      if (/Repository not found|not found/i.test(retryDetail)) {
        throw Object.assign(
          new Error(
            "Could not clone that repository. Check the name and that your token has access.",
          ),
          { code: "not_found" },
        );
      }
      throw new Error(retryDetail || `Failed to clone ${formatGitHubRepoLabel(ref)}.`);
    }

    // Best-effort cleanup so reconnect can retry cleanly.
    await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
    if (/Repository not found|not found/i.test(detail)) {
      throw Object.assign(
        new Error(
          "Could not clone that repository. Check the name and that your token has access.",
        ),
        { code: "not_found" },
      );
    }
    throw new Error(detail || `Failed to clone ${formatGitHubRepoLabel(ref)}.`);
  }
}

/**
 * True when `candidate` is exactly `root` or a path under it.
 * Uses resolved absolute paths; rejects `..` escapes.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolved === resolvedRoot || resolved.startsWith(prefix);
}

/**
 * Ensure the working tree is on `branch` and fast-forwarded to the fetched tip.
 * Always fetch + ff (even when HEAD already matches) so a prior failed ff is retried.
 * Verifies ff-ability before switching branches so a failed merge cannot leave HEAD
 * on the new branch while Connect throws (binding unchanged).
 * Never uses `checkout -B` (would reset an existing local branch and drop commits).
 */
function throwBranchSwitchGitError(detail: string, softDirty: boolean, fallback: string): never {
  if (softDirty && isWouldOverwriteMergeFailure(detail)) {
    throw new Error(softDirtyOverwriteMessage("branch-switch"));
  }
  throw new Error(detail || fallback);
}

async function ensureOnBranch(localPath: string, branch: string): Promise<void> {
  assertSafeBranchName(branch);

  // Align with syncProjectFromRemote: soft-dirty (.gitignore) / PM-local paths
  // are allowed; hard-dirty blocks.
  const dirtiness = await inspectWorkingTreeDirtiness(localPath, git());
  if (dirtiness === "hard-dirty") {
    throw new Error(
      `Can't switch to branch "${branch}" while there are local edits. Save or discard them first.`,
    );
  }
  const softDirty = dirtiness === "soft-dirty";

  const fetch = await git()(localPath, ["fetch", "origin", "--", branch]);
  if (fetch.code !== 0) {
    const detail = (fetch.stderr || fetch.stdout).trim();
    throw new Error(detail || `Couldn't fetch branch "${branch}".`);
  }

  const head = await git()(localPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headName = head.code === 0 ? head.stdout.trim() : "";
  const alreadyOnBranch = headName === branch;

  const localRef = await git()(localPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (localRef.code === 0) {
    // Fail before checkout when the local tip cannot ff to the fetched remote tip.
    const canFf = await git()(localPath, [
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      "FETCH_HEAD",
    ]);
    if (canFf.code !== 0) {
      throw new Error(
        `Branch "${branch}" has local commits that aren't on the remote, so it can't be fast-forwarded. Push or reset it first.`,
      );
    }

    if (!alreadyOnBranch) {
      const checkout = await git()(localPath, ["checkout", "--", branch]);
      if (checkout.code !== 0) {
        const detail = (checkout.stderr || checkout.stdout).trim();
        throwBranchSwitchGitError(detail, softDirty, `Couldn't switch to branch "${branch}".`);
      }
    }

    const ff = await git()(localPath, ["merge", "--ff-only", "FETCH_HEAD"]);
    if (ff.code !== 0) {
      // Best-effort restore if we switched away from the previous branch.
      if (!alreadyOnBranch && headName && headName !== "HEAD") {
        await git()(localPath, ["checkout", "--", headName]).catch(() => undefined);
      }
      const detail = (ff.stderr || ff.stdout).trim();
      if (softDirty && isWouldOverwriteMergeFailure(detail)) {
        throw new Error(softDirtyOverwriteMessage("branch-switch"));
      }
      throw new Error(
        detail ||
          `Branch "${branch}" has local commits that aren't on the remote, so it can't be fast-forwarded. Push or reset it first.`,
      );
    }
    return;
  }

  const checkout = await git()(localPath, ["checkout", "-b", branch, "FETCH_HEAD"]);
  if (checkout.code !== 0) {
    const detail = (checkout.stderr || checkout.stdout).trim();
    throwBranchSwitchGitError(detail, softDirty, `Couldn't switch to branch "${branch}".`);
  }
}

/**
 * True when `candidate` is a strict subdirectory of `root` (not `root` itself).
 * Used before `rm -rf` so a corrupted binding with `localPath === projectsRoot`
 * cannot wipe every managed clone.
 */
export function isStrictSubpathOf(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolved !== resolvedRoot && resolved.startsWith(prefix);
}

/**
 * Delete a managed clone directory from disk (no-op when path missing).
 * Refuses paths outside `<userData>/projects` and the projects root itself.
 */
export async function deleteManagedCloneDir(localPath: string): Promise<void> {
  const root = await projectsRoot();
  const resolved = resolve(localPath);
  if (!isStrictSubpathOf(resolved, root)) {
    throw new Error("Refusing to delete a path outside the managed projects directory.");
  }
  await rm(resolved, { recursive: true, force: true });
}

/** Record lastFetch after a successful open/Update sync. */
export async function noteSuccessfulFetch(localPath: string): Promise<void> {
  await touchProjectBindingLastFetch(localPath, Date.now());
}
