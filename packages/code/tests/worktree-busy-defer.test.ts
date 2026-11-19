/**
 * A PR job whose review worktree is leased by another live job (two open PRs
 * from one head branch in one repository) must defer, not fail: no failed run,
 * no error report, no consumed CI-fix attempt, no escalation comment.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runCiFixViaCli } from "../src/lib/acquirers/ci-failure-watcher";
import { GitHubReviewsClient } from "../src/lib/code-host/github/reviews";
import { requirePreparedWorktree } from "../src/lib/review/address";
import { runAddressReviewCommand } from "../src/lib/review/cli";
import { WebhookQueue } from "../src/lib/state/webhook-queue";
import { Utils } from "../src/lib/utils";
import { reviewWorktreeLeasePath } from "../src/lib/utils/review-worktree-lease";
import { prepareRepository } from "../src/lib/webhook/review-git";
import { processReviewWithPersistence } from "../src/lib/webhook/review-pipeline";
import { runtime } from "../src/lib/webhook/runtime";
import { WORKTREE_BUSY_EXIT_CODE, WorktreeBusyError } from "../src/lib/worker/usage-limit-protocol";
import type { PullRequestReviewEvent, WebhookServerConfig } from "../src/types/github-webhooks";

// Module records (not namespace imports) so spyOn can replace their exports.
const harnessUtils = await import("@devintern/utils");
const addressModule = await import("../src/lib/review/address");
const runRecorder = await import("../src/lib/state/run-recorder");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const IN_USE_RESULT = {
  success: false,
  error: "Worktree preparation failed: Review worktree /x is in use by another job (pid 1)",
  inUse: true,
};

describe("review worktree held by another live job", () => {
  let testDir: string;
  let originalWorktreeEnv: string | undefined;
  const spies: { mockRestore: () => void }[] = [];
  const children: { kill: () => void }[] = [];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "worktree-busy-"));
    originalWorktreeEnv = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const child of children.splice(0)) child.kill();
    if (originalWorktreeEnv === undefined) delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    else process.env.DEVINTERN_REVIEW_WORKTREE_PATH = originalWorktreeEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("address-review turns a real in-use preparation result into WorktreeBusyError", async () => {
    const origin = join(testDir, "origin.git");
    git(testDir, "init", "--bare", "--initial-branch=main", origin);
    const repo = join(testDir, "repo");
    git(testDir, "clone", origin, repo);
    git(repo, "config", "user.email", "t@t.dev");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");
    git(repo, "push", "origin", "HEAD:main");
    git(repo, "push", "origin", "HEAD:feature/shared");

    // Another live process holds the lease on the branch's worktree.
    const holder = Bun.spawn(["sleep", "30"]);
    children.push(holder);
    const path = Utils.getReviewWorktreePath("feature/shared", join(repo, ".git"));
    const leasePath = reviewWorktreeLeasePath(path);
    mkdirSync(join(leasePath, ".."), { recursive: true });
    const now = Date.now();
    writeFileSync(leasePath, JSON.stringify({ pid: holder.pid, startedAt: now, heartbeatAt: now }));

    const result = await Utils.prepareReviewWorktree("feature/shared", {
      cwd: repo,
      installDependencies: false,
    });
    expect(result.inUse).toBe(true);
    expect(() => requirePreparedWorktree(result)).toThrow(WorktreeBusyError);
    // Any other failure stays a plain error.
    expect(() => requirePreparedWorktree({ success: false, error: "boom" })).toThrow(
      "Failed to prepare worktree: boom",
    );
    expect(() => requirePreparedWorktree({ success: false, error: "boom" })).not.toThrow(
      WorktreeBusyError,
    );
  });

  test("address-review CLI exits WORKTREE_BUSY_EXIT_CODE with a deferred run and no error report", async () => {
    const endRun = spyOn(runRecorder, "endRun").mockImplementation(() => {});
    const captureError = spyOn(harnessUtils, "captureError").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const address = spyOn(addressModule, "addressReview").mockRejectedValue(
      new WorktreeBusyError("Review worktree busy: in use by another job"),
    );
    spies.push(endRun, captureError, exit, address);

    await expect(
      runAddressReviewCommand(["https://github.com/acme/widgets/pull/7"]),
    ).rejects.toThrow(`exit:${WORKTREE_BUSY_EXIT_CODE}`);

    expect(address).toHaveBeenCalledTimes(1);
    expect(endRun).toHaveBeenCalledWith("deferred", expect.stringContaining("busy"));
    expect(endRun).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(captureError).not.toHaveBeenCalled();
  });

  test("a CI-fix child exiting WORKTREE_BUSY_EXIT_CODE resolves deferred, other failures false", async () => {
    const script = join(testDir, "child.ts");
    const originalArgv1 = process.argv[1];
    try {
      process.argv[1] = script;
      writeFileSync(script, `process.exit(${WORKTREE_BUSY_EXIT_CODE});\n`);
      expect(await runCiFixViaCli("acme/widgets", 7, join(testDir, "f.json"))).toBe("deferred");
      writeFileSync(script, "process.exit(1);\n");
      expect(await runCiFixViaCli("acme/widgets", 7, join(testDir, "f.json"))).toBe(false);
      writeFileSync(script, "process.exit(0);\n");
      expect(await runCiFixViaCli("acme/widgets", 7, join(testDir, "f.json"))).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  test("webhook prepareRepository throws WorktreeBusyError instead of returning null", async () => {
    spies.push(
      spyOn(Utils, "isGitRepository").mockResolvedValue(true),
      spyOn(Utils, "prepareReviewWorktree").mockResolvedValue(IN_USE_RESULT),
    );
    await expect(prepareRepository("feature/shared")).rejects.toThrow(WorktreeBusyError);
  });

  test("webhook review keeps the event pending without an attempt or error report and schedules a retry", async () => {
    const queue = new WebhookQueue({ dbPath: join(testDir, "queue.db"), maxRetries: 3 });
    runtime.queue = queue;
    const scheduled: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === 60_000) {
        scheduled.push(ms);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    const endRun = spyOn(runRecorder, "endRun").mockImplementation(() => {});
    const captureError = spyOn(harnessUtils, "captureError").mockImplementation(() => {});
    spies.push(
      timer,
      endRun,
      captureError,
      spyOn(GitHubReviewsClient.prototype, "getPullRequestReviewComments").mockResolvedValue([]),
      spyOn(GitHubReviewsClient.prototype, "getBotUsername").mockResolvedValue("devintern"),
      spyOn(GitHubReviewsClient.prototype, "getCollaboratorPermission").mockResolvedValue({
        permission: "write",
      }),
      spyOn(Utils, "isGitRepository").mockResolvedValue(true),
      spyOn(Utils, "prepareReviewWorktree").mockResolvedValue(IN_USE_RESULT),
    );
    const event = {
      action: "submitted",
      review: {
        id: 1,
        body: "@devintern please fix",
        state: "changes_requested",
        user: { login: "dev", type: "User" },
      },
      pull_request: {
        number: 7,
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/7",
        head: { ref: "feature/shared" },
        base: { ref: "main" },
      },
      repository: { full_name: "acme/widgets" },
    } as unknown as PullRequestReviewEvent;
    const config = {
      port: 0,
      host: "127.0.0.1",
      webhookSecret: "s",
      autoReview: false,
      autoReviewMaxIterations: 0,
      validateIp: false,
      debug: false,
    } as WebhookServerConfig;

    try {
      const id = queue.enqueue("pull_request_review", event);
      await processReviewWithPersistence(id, event, config);

      const stored = queue.getEvent(id);
      expect(stored?.status).toBe("pending");
      expect(stored?.attempts).toBe(0);
      expect(scheduled).toEqual([60_000]);
      expect(endRun).toHaveBeenCalledWith("deferred", expect.stringContaining("busy"));
      expect(captureError).not.toHaveBeenCalled();
    } finally {
      runtime.queue = null;
      queue.close();
    }
  });
});
