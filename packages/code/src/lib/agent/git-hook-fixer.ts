/**
 * Git Hook Fixer
 *
 * Utility to automatically fix git hook errors using an AI agent.
 */

import { existsSync } from "fs";
import {
  detectUsageLimit,
  spawnAgent,
  reapTree,
  resolveExecutablePathWithRetry,
  UsageLimitError,
} from "@devintern/agent-harness";
import type { AgentHarness } from "@devintern/agent-harness";
import { buildHeadlessAgentInvocation, harnessSpawnEnv, HEADLESS_AGENT_STDIO } from "./spawn";
import { resolveAgentEffort, resolveAgentModel } from "./model";
import { agentSandboxPolicy, getSandbox } from "./sandbox";
import { createHarnessLogSink } from "../observability/harness-logs";
import { Utils } from "../utils";
import { headOnlyRemovesPublishedCommit } from "../utils/git-commit-push";
import { hasUncommittedWork, stageWorkTreeChanges } from "../utils/git-stage";
import { resolveOutputDir } from "../config/output-dir";

/**
 * Check whether the working tree is clean after a hook-fix attempt.
 * Untracked sandbox placeholders do not count as uncommitted changes.
 *
 * @param cwd - Optional git working directory
 * @returns `true` when no uncommitted changes remain (commit likely complete)
 */
export async function isCommitAlreadyComplete(cwd?: string): Promise<boolean> {
  const work = hasUncommittedWork(cwd ?? process.cwd());
  return work.success && !work.dirty;
}

/** Result of verifying a pre-push hook-fix attempt. */
export type PushHookFixVerification = {
  success: boolean;
  alreadyOnRemote: boolean;
  amended: boolean;
  message: string;
};

/** A published branch and the commit a resumed run started from. */
export type PushFixLease = { branch: string; sha: string };

/**
 * The lease whose publish would only delete published commits, if any.
 *
 * A reset back to an earlier commit is not a hook-fixable rewrite. Checked
 * before staging/amending leftover changes, which would otherwise mask HEAD
 * being behind the published commit.
 *
 * @param targetBranch - Branch being published
 * @param lease - Branch and commit the run started from, when it resumed one
 * @param cwd - Optional git working directory
 * @returns The lease when HEAD only rewinds it, otherwise `undefined`
 */
async function findPublishedRewind(
  targetBranch: string | undefined,
  lease: PushFixLease | undefined,
  cwd?: string,
): Promise<PushFixLease | undefined> {
  if (!targetBranch || lease?.branch !== targetBranch) return undefined;
  if (!targetBranch.startsWith("feature/")) return undefined;
  return (await headOnlyRemovesPublishedCommit(lease.sha, cwd)) ? lease : undefined;
}

/**
 * Verify a pre-push hook-fix without assuming a failed dry-run means "didn't amend".
 *
 * If HEAD already matches `origin/<branch>`, skip `git push --dry-run`. That
 * dry-run re-executes the full pre-push suite and can flake after the agent
 * already published the branch, which previously aborted PR creation.
 *
 * @param options - Working directory, expected branch, and (for a resumed run)
 *   the branch/commit the run started from
 */
export async function verifyPushHookFix(options?: {
  cwd?: string;
  expectedBranch?: string;
  /**
   * Branch and commit this run started from, when it resumed a published
   * branch. Publish rewrites a branch the agent rebased/amended with an
   * explicit lease, so the verification dry-run must probe with the same
   * lease; a plain dry-run is rejected as non-fast-forward and aborts publish.
   */
  lease?: PushFixLease;
}): Promise<PushHookFixVerification> {
  const cwd = options?.cwd;
  const currentBranch = await Utils.getCurrentBranch(cwd);

  if (options?.expectedBranch && currentBranch !== options.expectedBranch) {
    return {
      success: false,
      alreadyOnRemote: false,
      amended: false,
      message: `worktree HEAD is on '${currentBranch || "unknown"}' but expected '${options.expectedBranch}'`,
    };
  }

  const targetBranch = options?.expectedBranch ?? currentBranch ?? undefined;
  let amended = false;

  // A reset back to an earlier commit is not a hook-fixable rewrite: the
  // lease publish would delete published commits. Mirrors the guard in the
  // lease push itself.
  const rewound = await findPublishedRewind(targetBranch, options?.lease, cwd);
  if (rewound) {
    return {
      success: false,
      alreadyOnRemote: false,
      amended: false,
      message: `HEAD is behind the published commit ${rewound.sha.slice(0, 7)}; publishing under the lease would delete commits origin already has`,
    };
  }

  const workDir = cwd ?? process.cwd();
  if (hasUncommittedWork(workDir).dirty) {
    // Skips sandbox placeholders; `git add -A` fails on `/dev/null` mounts.
    const stageResult = stageWorkTreeChanges(workDir);
    if (!stageResult.success) {
      return {
        success: false,
        alreadyOnRemote: false,
        amended: false,
        message: `Failed to stage changes: ${stageResult.error}`,
      };
    }

    const amendResult = await Utils.executeGitCommand(
      ["commit", "--amend", "--no-edit", "--no-verify"],
      { cwd },
    );
    if (!amendResult.success) {
      return {
        success: false,
        alreadyOnRemote: false,
        amended: false,
        message: `Failed to amend commit: ${amendResult.error}`,
      };
    }
    amended = true;
  }

  if (targetBranch && (await Utils.remoteTrackingRefMatchesHead(targetBranch, { cwd }))) {
    return {
      success: true,
      alreadyOnRemote: true,
      amended,
      message: `HEAD already matches origin/${targetBranch}; skipping hook-rerunning dry-run`,
    };
  }

  // The lease rewrite in `pushCurrentBranch` rewrites `origin/<branch>` only
  // when HEAD no longer contains the recorded commit (the agent rebased or
  // amended the resumed branch). Mirror that decision here: a plain dry-run
  // would be rejected as non-fast-forward on a rewritten branch, so the fix
  // would be reported as failed and publish would never reach its lease push.
  let rewrittenLease: PushFixLease | undefined;
  if (
    targetBranch &&
    options?.lease?.branch === targetBranch &&
    targetBranch.startsWith("feature/")
  ) {
    const ancestor = await Utils.executeGitCommand(
      ["merge-base", "--is-ancestor", options.lease.sha, "HEAD"],
      { cwd },
    );
    if (!ancestor.success) rewrittenLease = options.lease;
  }

  let pushDryRunArgs: string[];
  if (!targetBranch) {
    pushDryRunArgs = ["push", "origin", "HEAD", "--dry-run"];
  } else if (rewrittenLease) {
    // The explicit lease value makes Git reject the probe when origin moved
    // past the recorded commit, exactly like the real lease push would.
    pushDryRunArgs = [
      "push",
      `--force-with-lease=refs/heads/${targetBranch}:${rewrittenLease.sha}`,
      "origin",
      `HEAD:refs/heads/${targetBranch}`,
      "--dry-run",
    ];
  } else {
    pushDryRunArgs = ["push", "origin", `HEAD:refs/heads/${targetBranch}`, "--dry-run"];
  }
  const pushDryRun = await Utils.executeGitCommand(pushDryRunArgs, { cwd });

  if (pushDryRun.success) {
    return {
      success: true,
      alreadyOnRemote: false,
      amended,
      message: "changes are committed and ready to push",
    };
  }

  const detail = [pushDryRun.error, pushDryRun.output].filter(Boolean).join("\n").trim();
  return {
    success: false,
    alreadyOnRemote: false,
    amended,
    message: detail || "push dry-run failed",
  };
}

/**
 * Builds the agent prompt for fixing a failed git hook.
 *
 * @param hookType - Which hook failed: pre-commit or pre-push
 * @param gitHookErrorLog - Glob path to previous hook error logs
 * @param lease - Branch and commit a resumed run started from, when publish
 *   rewrites that already-published branch under an explicit lease
 * @returns The prompt handed to the agent harness
 */
export function buildGitHookFixPrompt(
  hookType: "commit" | "push",
  gitHookErrorLog: string,
  lease?: PushFixLease,
): string {
  // A resumed run's branch is published and was rewritten by the agent, so a
  // plain push is rejected as non-fast-forward. Probe with the same explicit
  // lease publish uses instead. The dry run runs the pre-push hooks without
  // updating origin, and the runner publishes after the fix.
  const leasedPush =
    hookType === "push" && lease?.branch.startsWith("feature/")
      ? `git push --force-with-lease=refs/heads/${lease.branch}:${lease.sha} origin HEAD:refs/heads/${lease.branch} --dry-run`
      : undefined;

  // Concise prompt asking the agent to re-run the git command; avoids context
  // length issues from including full error output.
  const gitCommand = hookType === "commit" ? "git commit" : (leasedPush ?? "git push origin HEAD");

  const retryStep =
    hookType === "commit"
      ? '**Retry the commit** with an explicit message (never omit `-m` — unattended runs have no editor):\n   ```bash\n   git commit -m "fix: resolve pre-commit hook failures"\n   ```'
      : leasedPush
        ? `**Amend the existing commit** with your fixes:\n   \`\`\`bash\n   git commit --amend --no-edit\n   \`\`\`\n\n6. **Verify the fix** with the lease (dry run — do not publish):\n   \`\`\`bash\n   ${leasedPush}\n   \`\`\`\n   Do not run \`git push --force\` or a plain \`git push\`: this branch is already published and was rewritten, so the runner publishes it under \`--force-with-lease\` after your fix.`
        : "**Amend the existing commit** with your fixes:\n   ```bash\n   git commit --amend --no-edit\n   ```\n\n6. **Verify the fix** by running the push command again to ensure it succeeds.";

  const pushNote =
    hookType === "push"
      ? leasedPush
        ? "\n- Do not push: the runner publishes this rewritten branch under `--force-with-lease` after verification"
        : ""
      : "";

  return `# Git Hook Error - Fix Required

The git ${hookType} operation has failed, likely due to pre-${hookType} hooks checking code quality.

## Your Task

1. **Review recent hook errors** (optional but helpful):
   \`\`\`bash
   tail -n 100 ${gitHookErrorLog}
   \`\`\`
   This shows the last 100 lines of previous hook errors to understand patterns.

2. **Run the git command** to see what failed:
   \`\`\`bash
   ${gitCommand}
   \`\`\`

3. **Analyze the error output** and fix all issues. Common problems include:
   - **Linting errors**: Fix code style, formatting, or linting issues
   - **Test failures**: Fix failing tests or update test expectations
   - **Type errors**: Resolve TypeScript or type-checking issues
   - **Formatting issues**: Run formatters or fix code formatting
   - **Security issues**: Address security vulnerabilities or dependency issues

4. **Stage only real work**:
   \`\`\`bash
   git add -u
   git add <path>   # for each new file you intentionally created
   \`\`\`
   \`git add -u\` stages changed and deleted tracked files. Never stage the whole tree or
   every untracked entry in bulk: the sandbox mounts placeholder entries (\`.bashrc\`,
   \`.profile\`, \`.gitconfig\`, \`.claude/…\`, …) into the worktree root; git cannot stage
   them, and they must never be committed.

5. ${retryStep}

**Important**:
- Only fix the issues mentioned in the error output
- Do not modify unrelated code
- Ensure all tests pass if the hook runs tests
- Follow the project's coding standards and conventions
${hookType === "push" ? "- Make sure to amend the commit (git commit --amend --no-edit) so the fixes are included in the push" : ""}${pushNote}
`;
}

/**
 * Run agent to fix git hook errors.
 *
 * @param hookType - Type of git hook that failed ("commit" or "push")
 * @param harness - Agent harness to use
 * @param executablePath - Path to the agent CLI executable
 * @param maxTurns - Maximum number of turns for agent conversation
 * @param options - Optional working directory, expected branch, and lease
 * @returns `true` when hook errors were fixed and verified
 */
export async function runAgentHarnessToFixGitHook(
  hookType: "commit" | "push",
  harness: AgentHarness,
  executablePath: string,
  maxTurns: number,
  options?: {
    /** Working directory for the agent. */
    cwd?: string;
    /**
     * Branch the worktree HEAD must be on. When provided and the worktree is
     * on a different branch, the fix is aborted instead of risking operations
     * against a corrupted git state.
     */
    expectedBranch?: string;
    /**
     * Branch and commit the run started from. When the agent rewrote that
     * published branch, the verification dry-run uses the same explicit lease
     * the publish push uses.
     */
    lease?: PushFixLease;
  },
): Promise<boolean> {
  const cwd = options?.cwd;
  const expectedBranch = options?.expectedBranch;
  const lease = options?.lease;
  const workingDir = cwd || process.cwd();

  // Guard against a missing working directory. posix_spawn reports a
  // nonexistent cwd as `ENOENT` attributed to the *executable* path, which
  // looks like a missing agent binary but is really the worktree having been
  // removed out from under us. Fail with an actionable message instead.
  if (!existsSync(workingDir)) {
    console.error(
      `❌ Cannot fix git hook errors: working directory no longer exists: ${workingDir}`,
    );
    console.error(
      "   The review worktree was likely removed mid-run (e.g. pruned by a concurrent task).",
    );
    return false;
  }

  // Guard against a corrupted worktree. A misbehaving test in the PR's own
  // tree can `git init`/commit fixture data into the worktree and leave HEAD on
  // a stray branch (e.g. `tracking-test`). Running an agent — which may push —
  // from that state is how junk branches escape to the remote. If HEAD is not
  // on the branch we expect, abort rather than operate on a bad state.
  if (expectedBranch) {
    const branchResult = await Utils.executeGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workingDir,
    });
    const currentBranch = branchResult.success ? branchResult.output.trim() : "";
    if (currentBranch !== expectedBranch) {
      console.error(
        `❌ Cannot fix git hook errors: worktree HEAD is on '${currentBranch || "unknown"}' but expected '${expectedBranch}'.`,
      );
      console.error(
        "   The worktree git state was likely corrupted (e.g. by a test that manipulates git). Aborting to avoid pushing a stray branch.",
      );
      return false;
    }
  }

  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the hook fix outright.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: workingDir,
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    (async () => {
      console.log(`\n🔧 Attempting to fix git hook errors with ${harness.displayName}...`);

      // Get the path to the git-hook-errors.log file
      const gitHookErrorLog = `${resolveOutputDir()}/*/git-hook-errors.log`;
      const fixPrompt = buildGitHookFixPrompt(hookType, gitHookErrorLog, lease);

      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
      let stdoutOutput = "";
      let stderrOutput = "";
      let timedOut = false;
      let usageLimited = false;

      const { args: agentArgs, env: agentEnv } = await buildHeadlessAgentInvocation(
        harness,
        resolvedPath,
        fixPrompt,
        {
          maxTurns,
          skipPermissions: true,
          workingDir,
          model: resolveAgentModel(harness.name),
          effort: resolveAgentEffort(),
        },
      );

      // Spawn agent process to fix the issues. The executable path was already
      // resolved (and waited on through any auto-update swap) above. Prompt
      // goes on argv (`-p` / positional); stdin is ignored so TUI-first CLIs
      // do not try to attach a terminal.
      const { child: agent, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: agentArgs,
        spawnOptions: {
          stdio: HEADLESS_AGENT_STDIO,
          cwd: workingDir,
          env: harnessSpawnEnv(agentEnv),
        },
        sandbox: await getSandbox(harness.name),
        policy: agentSandboxPolicy(),
        sink: createHarnessLogSink({
          harness,
          label: `hook-fix-${hookType}`,
          cwd: workingDir,
          command: [resolvedPath, ...agentArgs],
        }),
      });

      const stopOnUsageLimit = (): void => {
        if (usageLimited) return;
        if (detectUsageLimit(stdoutOutput, stderrOutput).limited) {
          usageLimited = true;
          reapTree(agent, "SIGTERM");
        }
      };

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
          );
          reapTree(agent, "SIGTERM");
          setTimeout(() => {
            if (!agent.killed) {
              reapTree(agent, "SIGKILL");
            }
            sandboxCleanup().catch(() => {});
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      // Capture stdout
      if (agent.stdout) {
        agent.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          stdoutOutput += output;
          stopOnUsageLimit();
          process.stdout.write(output);
        });
      }

      // Capture stderr
      if (agent.stderr) {
        agent.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          stderrOutput += output;
          stopOnUsageLimit();
          process.stderr.write(output);
        });
      }

      agent.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        console.error(`❌ Failed to run ${harness.displayName} for git hook fix: ${error.message}`);
        resolve(false);
      });

      agent.on("close", async (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        if (timedOut) {
          console.error(
            `❌ ${harness.displayName} timed out after ${timeoutMinutes} minutes while fixing git hook`,
          );
          resolve(false);
          return;
        }
        if (usageLimited) {
          const usage = detectUsageLimit(stdoutOutput, stderrOutput);
          reject(new UsageLimitError(usage.resetsAt, usage.period));
          return;
        }
        if (code === 0) {
          console.log(
            `\n🔍 ${harness.displayName} completed - verifying the fix actually worked...`,
          );

          // Verify the fix by checking git status
          // For push: agent should have amended the commit, so we just verify nothing is staged
          // For commit: agent should have completed the commit, so we verify a clean state
          try {
            if (hookType === "commit") {
              // For commit fix: verify nothing is staged/modified (commit
              // succeeded). Untracked sandbox placeholders do not count.
              const work = hasUncommittedWork(workingDir);
              if (work.success && !work.dirty) {
                console.log("✅ Verification successful - commit completed successfully!");
                resolve(true);
              } else {
                console.log(
                  `⚠️  ${harness.displayName} fixed the code but didn't commit - staging the fix for a hooked retry...`,
                );
                const statusResult = await Utils.executeGitCommand(["status", "--porcelain"], {
                  cwd,
                });
                console.log(`   Changes: ${statusResult.output}`);

                // Stage the repair and let the caller retry its own commit.
                // That commit runs the hooks again (so an unrepaired failure
                // counts against --hook-retries instead of being bypassed with
                // --no-verify) and keeps the caller's message and author.
                const stageResult = stageWorkTreeChanges(workingDir);
                if (!stageResult.success) {
                  console.log("❌ Failed to stage changes:");
                  console.log(`   ${stageResult.error}`);
                  resolve(false);
                  return;
                }
                resolve(true);
              }
            } else {
              const verification = await verifyPushHookFix({ cwd, expectedBranch, lease });
              if (verification.success) {
                if (verification.amended) {
                  console.log("✅ Successfully amended commit manually!");
                }
                if (verification.alreadyOnRemote) {
                  console.log(`✅ Verification successful - ${verification.message}`);
                } else {
                  console.log(
                    "✅ Verification successful - changes are committed and ready to push!",
                  );
                }
                resolve(true);
              } else {
                console.log("❌ Push verification failed:");
                console.log(`   ${verification.message}`);
                resolve(false);
              }
            }
          } catch (verifyError) {
            console.log(`❌ Could not verify fix: ${verifyError}`);
            resolve(false);
          }
        } else {
          console.log(
            `\n❌ ${harness.displayName} exited with code ${code} while fixing git hook errors`,
          );
          resolve(false);
        }
      });
    })().catch((error) => {
      if (error instanceof UsageLimitError) {
        reject(error);
        return;
      }
      console.error(
        `❌ Failed to run ${harness.displayName} for git hook fix: ${error instanceof Error ? error.message : String(error)}`,
      );
      resolve(false);
    });
  });
}
