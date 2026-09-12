import { createReviewAdapter } from "./code-host/review-provider-factory";
import { assertCurrentGitLabOrigin } from "./change-origin";
/**
 * Address Review Command
 *
 * Manually address PR review feedback by fetching comments and running an AI agent.
 */

import {
  detectMaxTurnsReached,
  detectUsageLimit,
  resolveHarness,
  spawnAgent,
  reapTree,
  resolveExecutablePathWithRetry,
  UsageLimitError,
} from "@devintern/agent-harness";
import { readFileSync } from "fs";
import { buildHeadlessAgentArgs, HEADLESS_AGENT_STDIO } from "./agent-spawn";
import { resolveAgentEffort, resolveAgentModel } from "./agent-model";
import { parseChangeRequestUrl } from "./code-host";
import { getSandbox } from "./sandbox";
import { beginRun, endRun, recordRunStage } from "./run-recorder";
import { formatCiFixPrompt, formatReviewPrompt } from "./review-formatter";
import type { CiFailureFeedback } from "./review-formatter";
import { GIT_CLEAN_ARGS, Utils } from "./utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./git-hook-fixer";

export interface AddressReviewOptions {
  noPush?: boolean;
  noReply?: boolean;
  verbose?: boolean;
  /** Internal worker mode: fix the failures described in this JSON file. */
  ciFeedbackPath?: string;
  /** Internal worker guard: refuse stale feedback after the MR head moves. */
  expectedHeadSha?: string;
}

function readCiFeedbackFile(filePath: string): CiFailureFeedback {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CiFailureFeedback;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.failures)) {
    throw new Error(`Invalid CI feedback file: ${filePath}`);
  }
  return parsed;
}

/**
 * Run the configured agent harness to address review feedback.
 *
 * @param prompt - Full review prompt sent to the agent via argv (`-p` / positional)
 * @param workDir - Git working directory for the agent process
 * @param verbose - When true, log command and timeout details
 * @returns Whether the agent succeeded, its combined output, and max-turns flag
 */
export async function runAgent(
  prompt: string,
  workDir: string,
  verbose: boolean,
): Promise<{ success: boolean; output: string; maxTurnsReached?: boolean }> {
  const { harness, path: executablePath } = resolveHarness();
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the review.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: workDir,
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    (async () => {
      // Use high default like regular development (500 turns)
      const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);

      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
      const runOptions = {
        maxTurns,
        skipPermissions: true,
        workingDir: workDir,
        model: resolveAgentModel(),
        effort: resolveAgentEffort(),
      };
      const agentArgs = buildHeadlessAgentArgs(harness, prompt, runOptions);

      if (verbose) {
        console.log(`   Command: ${executablePath} ${harness.buildArgs(runOptions).join(" ")}`);
        console.log(`   Timeout: ${timeoutMinutes} minutes`);
      }

      let stdoutOutput = "";
      let stderrOutput = "";
      let timedOut = false;
      let usageLimited = false;

      const { child: agent, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: agentArgs,
        spawnOptions: { cwd: workDir, stdio: HEADLESS_AGENT_STDIO },
        sandbox: await getSandbox(harness.name),
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

      if (agent.stdout) {
        agent.stdout.on("data", (data: Buffer) => {
          const text = data.toString();
          stdoutOutput += text;
          stopOnUsageLimit();
          process.stdout.write(text);
        });
      }

      if (agent.stderr) {
        agent.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          stderrOutput += text;
          stopOnUsageLimit();
          process.stderr.write(text);
        });
      }

      agent.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          output: `Failed to run ${harness.displayName}: ${error.message}`,
        });
      });

      agent.on("close", (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        if (usageLimited) {
          const usage = detectUsageLimit(stdoutOutput, stderrOutput);
          reject(new UsageLimitError(usage.resetsAt));
          return;
        }
        const maxTurnsReached = detectMaxTurnsReached(
          stdoutOutput,
          stderrOutput,
          harness.supportsMaxTurns === true,
        );
        const output = stdoutOutput + stderrOutput;

        resolve({
          success: code === 0 && !maxTurnsReached && !timedOut,
          output: timedOut ? output + `\n\nTimed out after ${timeoutMinutes} minutes` : output,
          maxTurnsReached,
        });
      });
    })().catch((error) => {
      if (error instanceof UsageLimitError) {
        reject(error);
        return;
      }
      resolve({
        success: false,
        output: `Failed to run ${harness.displayName}: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
}

/**
 * Record in-scope comments as addressed (local dedupe) and leave 🎉 reactions
 * as visual feedback for humans. Reaction failures are logged and ignored:
 * they carry no gating meaning.
 *
 * @param client - GitHub reviews API client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param comments - Top-level and reply review comments to mark
 * @param conversationComments - Issue/conversation tab comments to mark
 */
/**
 * Fetch PR review feedback and run an agent to address unaddressed comments.
 *
 * @param prUrl - Full GitHub pull request or GitLab merge-request URL
 * @param options - Control push, comment marking, and verbosity
 * @throws When the PR is not open, worktree setup fails, or agent/commit/push fails
 */
export async function addressReview(
  prUrl: string,
  options: AddressReviewOptions = {},
): Promise<void> {
  const { noPush = false, noReply = false, verbose = false } = options;

  console.log("🔍 Parsing PR URL...");
  const identity = parseChangeRequestUrl(prUrl, {
    gitlabBaseUrl: process.env.GITLAB_CODE_HOST_URL,
  });
  if (!identity || identity.provider === "bitbucket") {
    throw new Error(
      `Invalid PR URL: ${prUrl}\n` +
        "Expected a GitHub pull request or configured GitLab merge-request URL.",
    );
  }
  const prNumber = identity.number;
  const repoSlug = identity.projectPath;
  console.log(`   Repository: ${repoSlug}`);
  console.log(`   ${identity.provider === "gitlab" ? "MR" : "PR"} #${prNumber}`);

  const adapter = await createReviewAdapter(identity, verbose);
  const { change: pr, gitAuthor } = adapter;
  console.log(`   Title: ${pr.title}`);
  console.log(`   Branch: ${pr.head.ref}`);
  console.log(`   State: ${pr.state}`);
  if (options.expectedHeadSha && pr.head.sha !== options.expectedHeadSha) {
    throw new Error(
      `${identity.provider === "gitlab" ? "MR" : "PR"} head changed before CI repair started; refusing stale feedback.`,
    );
  }

  const ciFeedback = options.ciFeedbackPath
    ? readCiFeedbackFile(options.ciFeedbackPath)
    : undefined;
  let prompt: string;
  let commitSummary: string;

  if (ciFeedback) {
    if (ciFeedback.failures.length === 0) {
      throw new Error("CI feedback contains no failing checks.");
    }
    console.log(
      `\n🤖 CI failure mode: fixing ${ciFeedback.failures.length} failing check(s) ` +
        `(${ciFeedback.failures.map((failure) => failure.name).join(", ")})`,
    );
    beginRun({
      origin: "ci_fix",
      repo: repoSlug,
      prNumber,
      prUrl,
      branch: pr.head.ref,
      harness: resolveHarness({ warnDeprecated: false }).harness.name,
    });
    recordRunStage("change_request", {
      status: "succeeded",
      summary: `fixing ${ciFeedback.failures.length} failing check(s) on ${pr.head.ref}`,
      detail: { failures: ciFeedback.failures, hasLogs: Boolean(ciFeedback.logs) },
    });
    prompt = formatCiFixPrompt({
      ...ciFeedback,
      repository: ciFeedback.repository || repoSlug,
      prTitle: pr.title,
      branch: pr.head.ref,
    });
    commitSummary = "Fix CI failures";
  } else {
    const selection = await adapter.loadFeedback();
    if (!selection) return;
    beginRun({
      origin: "pr_mention",
      repo: repoSlug,
      prNumber,
      prUrl,
      branch: pr.head.ref,
      harness: resolveHarness({ warnDeprecated: false }).harness.name,
    });
    recordRunStage("change_request", {
      status: "succeeded",
      summary: selection.stageSummary,
      detail: selection.stageDetail,
    });
    prompt = formatReviewPrompt(selection.feedback);
    commitSummary = `Address review feedback from ${selection.feedback.reviewer}`;
  }

  // Prepare the review worktree
  console.log(`\n🌿 Preparing review worktree for branch: ${pr.head.ref}`);

  // Check if we're in a git repo
  const isGitRepo = await Utils.isGitRepository();
  if (!isGitRepo) {
    throw new Error("Not in a git repository. Please run this command from within the repository.");
  }
  if (identity.provider === "gitlab") {
    await assertCurrentGitLabOrigin(identity, { verbose: false });
  }

  // Prepare the single reusable worktree for this review
  const worktreeResult = await Utils.prepareReviewWorktree(pr.head.ref, {
    verbose,
  });

  if (!worktreeResult.success) {
    throw new Error(`Failed to prepare worktree: ${worktreeResult.error}`);
  }

  const workDir = worktreeResult.path!;
  console.log(`✅ Worktree ready at: ${workDir}`);

  // Set git config for bot author if available (so Agent's commits are attributed to bot)
  let originalGitName: string | null = null;
  let originalGitEmail: string | null = null;

  if (gitAuthor) {
    // Save original git config
    const nameResult = await Utils.executeGitCommand(["config", "user.name"], {
      verbose: false,
      cwd: workDir,
    });
    if (nameResult.success && nameResult.output.trim()) {
      originalGitName = nameResult.output.trim();
    }

    const emailResult = await Utils.executeGitCommand(["config", "user.email"], {
      verbose: false,
      cwd: workDir,
    });
    if (emailResult.success && emailResult.output.trim()) {
      originalGitEmail = emailResult.output.trim();
    }

    // Set bot author in git config
    await Utils.executeGitCommand(["config", "user.name", gitAuthor.name], {
      verbose,
      cwd: workDir,
    });
    await Utils.executeGitCommand(["config", "user.email", gitAuthor.email], {
      verbose,
      cwd: workDir,
    });

    if (verbose) {
      console.log(`   Set git config to bot author: ${gitAuthor.name} <${gitAuthor.email}>`);
    }
  }

  try {
    // Run Agent (prompt is passed via stdin, no file created)
    console.log("\n🤖 Running Agent to address review feedback...");
    const agentResult = await runAgent(prompt, workDir, verbose);

    if (agentResult.maxTurnsReached) {
      console.error("\n❌ Agent reached max turns limit without completing the task");
      throw new Error(
        "Agent reached max turns limit. Increase CLAUDE_MAX_TURNS environment variable.",
      );
    }

    if (!agentResult.success) {
      console.error("\n❌ Agent failed to complete successfully");
      throw new Error("Agent failed to complete successfully");
    }

    console.log("\n✅ Agent completed successfully");

    // Check if there are unpushed commits (Agent should have committed)
    const unpushedResult = await Utils.executeGitCommand(
      ["log", `origin/${pr.head.ref}..HEAD`, "--oneline"],
      { verbose, cwd: workDir },
    );
    const hasUnpushed = unpushedResult.success && unpushedResult.output.trim().length > 0;

    // Check if there are uncommitted changes (fallback if Agent didn't commit)
    const hasUncommitted = await Utils.hasUncommittedChanges(workDir);

    if (!hasUncommitted && !hasUnpushed) {
      console.log("\n⚠️  No changes were made by @devintern/code");
      console.log(`   View PR: ${prUrl}`);
      if (ciFeedback) {
        throw new Error("CI fix agent made no changes");
      }
      endRun("succeeded", "agent made no changes");
      return;
    }

    // Get hook retries configuration
    const hookRetries = parseInt(process.env.HOOK_RETRIES || "10", 10);
    const { harness, path: executablePath } = resolveHarness();
    const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);
    const prBranch = pr.head.ref;

    // Verify Agent didn't switch branches during execution (e.g., checking out main for comparison)
    const currentBranch = await Utils.getCurrentBranch(workDir);
    if (currentBranch && currentBranch !== prBranch) {
      console.warn(
        `⚠️  Agent switched from '${prBranch}' to '${currentBranch}' during execution, switching back...`,
      );
      const switchBack = await Utils.executeGitCommand(["checkout", prBranch], {
        verbose,
        cwd: workDir,
      });
      if (!switchBack.success) {
        console.warn(`   Simple checkout failed, trying stash + checkout...`);
        await Utils.executeGitCommand(["stash", "--include-untracked"], {
          verbose: false,
          cwd: workDir,
        });
        const switchAfterStash = await Utils.executeGitCommand(["checkout", prBranch], {
          verbose,
          cwd: workDir,
        });
        if (switchAfterStash.success) {
          await Utils.executeGitCommand(["stash", "pop"], {
            verbose: false,
            cwd: workDir,
          });
        } else {
          console.error(
            `❌ Failed to switch back to branch '${prBranch}': ${switchAfterStash.error}`,
          );
          throw new Error(`Failed to switch back to branch '${prBranch}'`);
        }
      }
      console.log(`✅ Switched back to '${prBranch}'`);
    }

    // Prefer Agent's commits, but handle uncommitted changes as fallback
    if (hasUnpushed) {
      console.log("\n✅ Changes committed by @devintern/code");
    } else if (hasUncommitted) {
      console.log("\n📝 Agent left changes uncommitted, committing now...");

      // Try committing with retry logic for git hook failures
      let commitAttempt = 0;
      let commitSuccess = false;

      while (commitAttempt <= hookRetries && !commitSuccess) {
        commitAttempt++;
        const commitResult = await Utils.commitChanges(`PR-${prNumber}`, commitSummary, {
          verbose,
          author: gitAuthor,
          cwd: workDir,
        });

        if (commitResult.success) {
          console.log("✅ Changes committed successfully");
          commitSuccess = true;
          break;
        }

        // Check if this is a git hook error that we can try to fix
        if (commitResult.hookError && commitAttempt <= hookRetries) {
          console.log(`\n⚠️  Git hook failed (attempt ${commitAttempt}/${hookRetries + 1})`);

          // Try to fix the hook error with agent
          const fixed = await runAgentHarnessToFixGitHook(
            "commit",
            harness,
            executablePath,
            maxTurns,
            workDir,
            pr.head.ref,
          );

          if (fixed) {
            if (await isCommitAlreadyComplete(workDir)) {
              console.log("✅ Commit already completed during hook fix");
              commitSuccess = true;
              break;
            }

            console.log(`\n🔄 Retrying commit after ${harness.displayName} fixed the issues...`);
            continue;
          } else {
            console.log("\n❌ Could not fix git hook errors automatically");
            break;
          }
        } else {
          // Not a hook error or out of retries
          if (commitAttempt > hookRetries) {
            console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
          }
          console.error(`\n❌ Failed to commit changes: ${commitResult.message}`);
          throw new Error(`Commit failed: ${commitResult.message}`);
        }
      }

      if (!commitSuccess) {
        throw new Error("Failed to commit changes after retries");
      }
    }

    // Push changes if requested
    if (!noPush) {
      await adapter.beforePush();
      console.log("\n📤 Pushing changes...");

      // Try pushing with retry logic for git hook failures
      let pushAttempt = 0;
      let pushSuccess = false;

      while (pushAttempt <= hookRetries && !pushSuccess) {
        pushAttempt++;
        const pushResult = await Utils.pushCurrentBranch({
          verbose,
          cwd: workDir,
          expectedBranch: pr.head.ref,
        });

        if (pushResult.success) {
          console.log("✅ Changes pushed successfully");
          pushSuccess = true;
          break;
        }

        // Check if this is a git hook error that we can try to fix
        if (pushResult.hookError && pushAttempt <= hookRetries) {
          console.log(`\n⚠️  Git pre-push hook failed (attempt ${pushAttempt}/${hookRetries + 1})`);

          // Try to fix the hook error with agent
          const fixed = await runAgentHarnessToFixGitHook(
            "push",
            harness,
            executablePath,
            maxTurns,
            workDir,
            pr.head.ref,
          );

          if (fixed) {
            console.log(
              `\n🔄 Retrying push after ${harness.displayName} fixed and amended the commit...`,
            );
            // Agent was instructed to amend the commit, so just retry the push
            continue;
          } else {
            console.log("\n❌ Could not fix git pre-push hook errors automatically");
            break;
          }
        } else {
          // Not a hook error or out of retries
          if (pushAttempt > hookRetries) {
            console.log(`\n❌ Max retries (${hookRetries}) exceeded for git hook fixes`);
          }
          console.error(`\n❌ Failed to push changes: ${pushResult.message}`);
          throw new Error(`Push failed: ${pushResult.message}`);
        }
      }

      if (!pushSuccess) {
        throw new Error("Failed to push changes after retries");
      }
    } else {
      console.log("\n⏭️  Skipping push (--no-push flag)");
    }

    // Mark comments as addressed if requested (only if push succeeded)
    if (!ciFeedback && !noReply && !noPush) {
      await adapter.acknowledge(agentResult.output);
    } else if (!ciFeedback && noReply) {
      console.log("\n⏭️  Skipping marking comments (--no-reply flag)");
    }

    console.log(
      ciFeedback
        ? `\n✅ Successfully pushed a CI fix for ${identity.provider === "gitlab" ? "MR" : "PR"} #${prNumber}`
        : `\n✅ Successfully addressed review for ${identity.provider === "gitlab" ? "MR" : "PR"} #${prNumber}`,
    );
    console.log(`   View ${identity.provider === "gitlab" ? "MR" : "PR"}: ${prUrl}`);
    endRun("succeeded");
    return;
  } catch (error) {
    if (error instanceof UsageLimitError) {
      endRun("deferred", error.message);
    } else {
      endRun("failed", (error as Error).message);
    }
    throw error;
  } finally {
    // Clean up any untracked files left by linters/tools/agent
    const statusResult = await Utils.executeGitCommand(["status", "--porcelain"], {
      verbose: false,
      cwd: workDir,
    });

    if (statusResult.success && statusResult.output.trim()) {
      // Check for untracked files (lines starting with "??")
      const untrackedLines = statusResult.output
        .split("\n")
        .filter((line) => line.startsWith("??"));

      if (untrackedLines.length > 0) {
        if (verbose) {
          console.log("\n🧹 Cleaning up untracked files...");
          untrackedLines.forEach((line) => {
            const file = line.substring(3).trim();
            console.log(`   Removing: ${file}`);
          });
        }

        // Use git clean to remove all untracked files and directories
        // -f: force, -d: directories
        await Utils.executeGitCommand(GIT_CLEAN_ARGS, {
          verbose: false,
          cwd: workDir,
        });
      }
    }

    // Restore original git config if we changed it
    if (gitAuthor) {
      if (originalGitName) {
        await Utils.executeGitCommand(["config", "user.name", originalGitName], {
          verbose: false,
          cwd: workDir,
        });
      } else {
        await Utils.executeGitCommand(["config", "--unset", "user.name"], {
          verbose: false,
          cwd: workDir,
        });
      }

      if (originalGitEmail) {
        await Utils.executeGitCommand(["config", "user.email", originalGitEmail], {
          verbose: false,
          cwd: workDir,
        });
      } else {
        await Utils.executeGitCommand(["config", "--unset", "user.email"], {
          verbose: false,
          cwd: workDir,
        });
      }

      if (verbose) {
        console.log("   Restored original git config");
      }
    }
  }
}
