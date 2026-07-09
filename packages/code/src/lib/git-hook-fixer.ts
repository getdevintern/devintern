/**
 * Git Hook Fixer
 *
 * Utility to automatically fix git hook errors using an AI agent.
 */

import { type ChildProcess } from "child_process";
import { existsSync } from "fs";
import {
  type AgentHarness,
  spawnReapable,
  reapTree,
  resolveExecutablePathWithRetry,
} from "@devintern/agent-harness";
import { Utils } from "./utils";

/**
 * Check whether the working tree is clean after a hook-fix attempt.
 *
 * @param cwd - Optional git working directory
 * @returns `true` when no uncommitted changes remain (commit likely complete)
 */
export async function isCommitAlreadyComplete(cwd?: string): Promise<boolean> {
  return !(await Utils.hasUncommittedChanges(cwd));
}

/**
 * Run agent to fix git hook errors.
 *
 * @param hookType - Type of git hook that failed ("commit" or "push")
 * @param harness - Agent harness to use
 * @param executablePath - Path to the agent CLI executable
 * @param maxTurns - Maximum number of turns for agent conversation
 * @param cwd - Optional working directory for the agent
 * @param expectedBranch - Optional branch the worktree HEAD must be on. When
 *   provided and the worktree is on a different branch, the fix is aborted
 *   instead of risking operations against a corrupted git state.
 * @returns `true` when hook errors were fixed and verified
 */
export async function runAgentHarnessToFixGitHook(
  hookType: "commit" | "push",
  harness: AgentHarness,
  executablePath: string,
  maxTurns: number,
  cwd?: string,
  expectedBranch?: string,
): Promise<boolean> {
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

  return new Promise((resolve) => {
    console.log(`\n🔧 Attempting to fix git hook errors with ${harness.displayName}...`);

    // Create a concise prompt that asks the agent to re-run the git command
    // This avoids context length issues from including full error output
    const gitCommand = hookType === "commit" ? "git commit" : "git push origin HEAD";

    // Get the path to the git-hook-errors.log file
    const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
    const gitHookErrorLog = `${baseOutputDir}/*/git-hook-errors.log`;

    const fixPrompt = `# Git Hook Error - Fix Required

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

4. **Stage your changes** with:
   \`\`\`bash
   git add .
   \`\`\`

5. ${
      hookType === "commit"
        ? "**Retry the commit** to verify it succeeds."
        : "**Amend the existing commit** with your fixes:\n   ```bash\n   git commit --amend --no-edit\n   ```\n\n6. **Verify the fix** by running the push command again to ensure it succeeds."
    }

**Important**:
- Only fix the issues mentioned in the error output
- Do not modify unrelated code
- Ensure all tests pass if the hook runs tests
- Follow the project's coding standards and conventions
${hookType === "push" ? "- Make sure to amend the commit (git commit --amend --no-edit) so the fixes are included in the push" : ""}
`;

    const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
    let stdoutOutput = "";
    let stderrOutput = "";
    let timedOut = false;

    const agentArgs = harness.buildArgs({ maxTurns, skipPermissions: true, workingDir });

    // Spawn agent process to fix the issues. The executable path was already
    // resolved (and waited on through any auto-update swap) above.
    const agent: ChildProcess = spawnReapable(resolvedPath, agentArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workingDir,
    });

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
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    // Capture stdout
    if (agent.stdout) {
      agent.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutOutput += output;
        process.stdout.write(output);
      });
    }

    // Capture stderr
    if (agent.stderr) {
      agent.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrOutput += output;
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
      if (timedOut) {
        console.error(
          `❌ ${harness.displayName} timed out after ${timeoutMinutes} minutes while fixing git hook`,
        );
        resolve(false);
        return;
      }
      if (code === 0) {
        console.log(`\n🔍 ${harness.displayName} completed - verifying the fix actually worked...`);

        // Verify the fix by checking git status
        // For push: agent should have amended the commit, so we just verify nothing is staged
        // For commit: agent should have completed the commit, so we verify a clean state
        try {
          const statusResult = await Utils.executeGitCommand(["status", "--porcelain"], { cwd });

          if (hookType === "commit") {
            // For commit fix: verify nothing is staged/modified (commit succeeded)
            if (statusResult.success && statusResult.output.trim() === "") {
              console.log("✅ Verification successful - commit completed successfully!");
              resolve(true);
            } else {
              console.log(
                `⚠️  ${harness.displayName} fixed the code but didn't commit - committing manually...`,
              );
              console.log(`   Changes: ${statusResult.output}`);

              // Attempt to stage and commit manually
              const stageResult = await Utils.executeGitCommand(["add", "."], {
                cwd,
              });
              if (!stageResult.success) {
                console.log("❌ Failed to stage changes:");
                console.log(`   ${stageResult.error}`);
                resolve(false);
                return;
              }

              const commitResult = await Utils.executeGitCommand(["commit", "--no-verify"], {
                cwd,
              });
              if (commitResult.success) {
                console.log("✅ Successfully committed changes manually!");
                resolve(true);
              } else {
                console.log("❌ Failed to commit changes:");
                console.log(`   ${commitResult.error}`);
                resolve(false);
              }
            }
          } else {
            // For push fix: verify changes are committed and ready to push.
            // Target the expected branch explicitly (HEAD:refs/heads/<branch>)
            // rather than a bare HEAD, so a stray HEAD can never validate a
            // push to the wrong/new remote branch. This is a --dry-run, so it
            // never publishes anything.
            const pushDryRunArgs = expectedBranch
              ? ["push", "origin", `HEAD:refs/heads/${expectedBranch}`, "--dry-run"]
              : ["push", "origin", "HEAD", "--dry-run"];
            const pushDryRun = await Utils.executeGitCommand(pushDryRunArgs, { cwd });

            if (pushDryRun.success) {
              console.log("✅ Verification successful - changes are committed and ready to push!");
              resolve(true);
            } else {
              console.log(
                `⚠️  ${harness.displayName} fixed the code but didn't amend - amending manually...`,
              );

              // Check if there are uncommitted changes to amend
              const statusCheck = await Utils.executeGitCommand(["status", "--porcelain"], {
                cwd,
              });
              if (statusCheck.success && statusCheck.output.trim() !== "") {
                // Stage all changes
                const stageResult = await Utils.executeGitCommand(["add", "."], { cwd });
                if (!stageResult.success) {
                  console.log("❌ Failed to stage changes:");
                  console.log(`   ${stageResult.error}`);
                  resolve(false);
                  return;
                }

                // Amend the commit
                const amendResult = await Utils.executeGitCommand(
                  ["commit", "--amend", "--no-edit", "--no-verify"],
                  { cwd },
                );
                if (amendResult.success) {
                  console.log("✅ Successfully amended commit manually!");

                  // Verify push would work now (explicit branch ref, dry-run)
                  const retryPush = await Utils.executeGitCommand(pushDryRunArgs, { cwd });
                  if (retryPush.success) {
                    console.log("✅ Verification successful - ready to push!");
                    resolve(true);
                  } else {
                    console.log("❌ Push would still fail after amend:");
                    console.log(`   ${retryPush.error || retryPush.output}`);
                    resolve(false);
                  }
                } else {
                  console.log("❌ Failed to amend commit:");
                  console.log(`   ${amendResult.error}`);
                  resolve(false);
                }
              } else {
                console.log("❌ Push dry-run failed but no uncommitted changes to amend:");
                console.log(`   ${pushDryRun.error || pushDryRun.output}`);
                resolve(false);
              }
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

    // Send the fix prompt to the agent
    if (agent.stdin) {
      agent.stdin.write(fixPrompt);
      agent.stdin.end();
    }
  });
}
