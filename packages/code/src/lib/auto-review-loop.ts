/**
 * Automatic PR review feedback loop
 *
 * After creating a PR, this module runs an iterative self-review process:
 * 1. Request review from Agent (analyze PR diff)
 * 2. Get structured JSON feedback with priorities
 * 3. Address critical/high/medium priority issues
 * 4. Repeat until all important issues resolved or max iterations reached
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  type AgentHarness,
  spawnReapable,
  reapTree,
  resolveExecutablePathWithRetry,
} from "@devintern/agent-harness";
import {
  type AutoReviewLoopOptions,
  type AutoReviewLoopResult,
  type ReviewFeedback,
  type ReviewFeedbackItem,
  type ReviewPriority,
} from "../types/auto-review.js";

const PRIORITY_WEIGHTS: Record<ReviewPriority, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/**
 * Generate a review prompt for the agent based on the PR diff.
 *
 * @param repository - GitHub repository slug (`owner/repo`)
 * @param prNumber - Pull request number
 * @param prDiff - Unified diff text for the PR
 * @param iteration - Current auto-review iteration (1-based)
 * @returns Prompt instructing the agent to return structured JSON feedback
 */
function generateReviewPrompt(
  repository: string,
  prNumber: number,
  prDiff: string,
  iteration: number,
): string {
  return `You are reviewing a pull request. Your task is to analyze the code changes and provide structured feedback in JSON format.

## PR Information
- **Repository**: ${repository}
- **PR Number**: #${prNumber}
- **Review Iteration**: ${iteration}

## Review Criteria
Analyze the following aspects:
1. **Code Quality & Best Practices**: Adherence to coding standards, maintainability, readability
2. **Potential Bugs**: Logic errors, edge cases, error handling
3. **Performance**: Inefficient algorithms, unnecessary operations, resource usage
4. **Security**: Vulnerabilities, input validation, authentication/authorization
5. **Test Coverage**: Missing tests, inadequate test cases
6. **Documentation**: Missing/unclear comments, outdated documentation

## PR Diff
\`\`\`diff
${prDiff}
\`\`\`

## Instructions
1. Review the code changes thoroughly
2. Identify issues across all criteria listed above
3. Assign priority to each issue:
   - **critical**: Security vulnerabilities, data loss risks, breaking changes
   - **high**: Bugs that will likely cause failures, major performance issues
   - **medium**: Code quality issues, minor bugs, missing tests
   - **low**: Style inconsistencies, minor optimizations
   - **info**: Suggestions, alternatives, educational feedback

4. Provide your feedback as JSON in the following format:

\`\`\`json
{
  "summary": "Brief overall assessment of the PR (2-3 sentences)",
  "items": [
    {
      "priority": "critical|high|medium|low|info",
      "category": "code-quality|bug|performance|security|testing|documentation|style",
      "file": "path/to/file.ts",
      "line": "42" or "42-45",
      "issue": "Clear description of the issue",
      "suggestion": "Specific actionable fix or improvement"
    }
  ],
  "approved": false
}
\`\`\`

5. Set "approved": true ONLY if all issues are low priority or informational
6. Be constructive and specific in your feedback
7. Focus on actionable improvements

**IMPORTANT**: Your response must be valid JSON only. Do not include any explanatory text outside the JSON block.
`;
}

/**
 * Generate a prompt instructing the agent to fix review feedback items.
 *
 * @param feedbackItems - Prioritized feedback items to address
 * @param iteration - Current iteration (controls commit vs amend instructions)
 * @returns Fix prompt for the agent harness
 */
function generateFixPrompt(feedbackItems: ReviewFeedbackItem[], iteration: number): string {
  const itemsList = feedbackItems
    .map(
      (item, idx) =>
        `${idx + 1}. **[${item.priority.toUpperCase()}] ${item.category}** ${item.file ? `in \`${item.file}\`` : ""}${item.line ? ` (line ${item.line})` : ""}
   - Issue: ${item.issue}
   - Suggestion: ${item.suggestion}`,
    )
    .join("\n\n");

  const commitInstruction =
    iteration === 1
      ? `4. After making changes, commit them with a descriptive message:
   - Format: "fix: address PR review feedback"
   - Include which issues were fixed in the commit body
   - DO NOT push - this will be done automatically`
      : `4. After making changes, amend them into the previous commit:
   - Use: git commit --amend
   - Extend the existing commit message by appending a new line describing iteration ${iteration} fixes
   - DO NOT push - this will be done automatically`;

  return `You received the following feedback on your pull request implementation. Please address each item systematically.

## Review Iteration ${iteration}

## Feedback to Address
${itemsList}

## Instructions
1. Address each feedback item in order of priority (critical → high → medium)
2. Make minimal, focused changes to fix the issues
3. Ensure you don't introduce new bugs while fixing existing ones
${commitInstruction}

**IMPORTANT**:
- Focus on the specific issues mentioned
- Don't make unrelated changes
- Test your changes if possible
`;
}

/**
 * Get the PR diff using git against the remote base branch (no GitHub API).
 *
 * @param baseBranch - Target/base branch name (may include `origin/` prefix)
 * @param workingDir - Repository working directory
 * @returns Unified diff from merge-base to HEAD
 * @throws When the remote base branch cannot be resolved or diff generation fails
 */
function getPRDiff(baseBranch: string, workingDir: string): string {
  // Strip origin/ prefix if present for fetch command
  const branchName = baseBranch.replace(/^origin\//, "");
  const remoteBase = `origin/${branchName}`;

  // Explicitly fetch the base branch we need
  console.log(`📥 Fetching ${remoteBase} from origin...`);
  try {
    execSync(`git fetch origin ${branchName}:refs/remotes/origin/${branchName}`, {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (fetchError) {
    // Try a broader fetch if specific branch fetch fails
    console.log(`⚠️  Specific branch fetch failed, trying full fetch...`);
    try {
      execSync("git fetch origin", {
        cwd: workingDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      console.log(`⚠️  Full fetch also failed, continuing with existing refs...`);
    }
  }

  // Check if this is a shallow clone and unshallow if needed
  try {
    const isShallow = execSync("git rev-parse --is-shallow-repository", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    if (isShallow === "true") {
      console.log(`📥 Shallow repository detected, fetching full history...`);
      try {
        execSync("git fetch --unshallow origin", {
          cwd: workingDir,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        console.log(`⚠️  Failed to unshallow, trying to deepen history...`);
        execSync("git fetch --deepen=1000 origin", {
          cwd: workingDir,
          encoding: "utf-8",
          stdio: "pipe",
        });
      }
    }
  } catch {
    // Ignore - might be an old git version
  }

  // Verify the remote branch exists
  try {
    execSync(`git rev-parse --verify ${remoteBase}`, {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    throw new Error(`Remote branch ${remoteBase} not found. Make sure it exists on the remote.`);
  }

  // Try multiple approaches to get the diff
  // Approach 1: Use three-dot syntax which handles merge-base internally
  console.log(`🔍 Getting diff between ${remoteBase} and HEAD...`);
  try {
    const result = execSync(`git diff ${remoteBase}...HEAD`, {
      cwd: workingDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return result;
  } catch (error) {
    console.log(`⚠️  Three-dot diff failed: ${error}`);
  }

  // Approach 2: Try explicit merge-base
  try {
    const mergeBase = execSync(`git merge-base HEAD ${remoteBase}`, {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    const result = execSync(`git diff ${mergeBase}..HEAD`, {
      cwd: workingDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return result;
  } catch (error) {
    console.log(`⚠️  Merge-base diff failed: ${error}`);
  }

  // Approach 3: Fall back to two-dot diff (shows all changes, not just since divergence)
  console.log(`⚠️  Falling back to two-dot diff (may include extra changes)...`);
  try {
    const result = execSync(`git diff ${remoteBase}..HEAD`, {
      cwd: workingDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return result;
  } catch (error) {
    throw new Error(`Failed to get PR diff with all approaches: ${error}`);
  }
}

/**
 * Parse structured JSON review feedback from agent output.
 *
 * @param agentOutput - Raw stdout from the review agent
 * @returns Validated {@link ReviewFeedback} object
 * @throws When no JSON is found or the structure is invalid
 */
function parseReviewFeedback(agentOutput: string): ReviewFeedback {
  // Extract JSON from potential markdown code blocks
  const jsonMatch =
    agentOutput.match(/```json\s*([\s\S]*?)\s*```/) || agentOutput.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("No JSON found in Agent output");
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];

  try {
    const feedback = JSON.parse(jsonStr) as ReviewFeedback;

    // Validate structure
    if (
      !feedback.summary ||
      !Array.isArray(feedback.items) ||
      typeof feedback.approved !== "boolean"
    ) {
      throw new Error("Invalid feedback structure");
    }

    return feedback;
  } catch (error) {
    throw new Error(`Failed to parse review feedback JSON: ${error}`);
  }
}

/**
 * Run the agent harness with a prompt and capture stdout.
 *
 * @param prompt - Prompt sent to the agent via stdin
 * @param workingDir - Git working directory
 * @param harness - Resolved agent harness configuration
 * @param executablePath - Path to the agent CLI executable
 * @returns Agent stdout on success
 * @throws When the agent times out or exits with a non-zero code
 */
async function runAgentPrompt(
  prompt: string,
  workingDir: string,
  harness: AgentHarness,
  executablePath: string,
): Promise<string> {
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the review.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: workingDir,
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

    const agentArgs = harness.buildArgs({
      maxTurns: 500,
      skipPermissions: true,
      workingDir,
    });
    const agentProcess = spawnReapable(resolvedPath, agentArgs, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(
      () => {
        timedOut = true;
        console.error(
          `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
        );
        reapTree(agentProcess, "SIGTERM");
        setTimeout(() => {
          if (!agentProcess.killed) {
            reapTree(agentProcess, "SIGKILL");
          }
        }, 10_000);
      },
      timeoutMinutes * 60 * 1000,
    );

    agentProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    agentProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    agentProcess.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${harness.displayName} timed out after ${timeoutMinutes} minutes`));
      } else if (code !== 0) {
        reject(new Error(`${harness.displayName} exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    agentProcess.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn ${harness.displayName}: ${error}`));
    });

    // Send prompt to stdin
    agentProcess.stdin?.write(prompt);
    agentProcess.stdin?.end();
  });
}

/**
 * Filter feedback items at or above a minimum priority threshold.
 *
 * @param items - All review feedback items
 * @param minPriority - Minimum priority to include
 * @returns Items meeting the priority threshold
 */
function filterByPriority(
  items: ReviewFeedbackItem[],
  minPriority: ReviewPriority,
): ReviewFeedbackItem[] {
  const minWeight = PRIORITY_WEIGHTS[minPriority];
  return items.filter((item) => PRIORITY_WEIGHTS[item.priority] >= minWeight);
}

/**
 * Stage all changes and check whether anything is ready to commit.
 *
 * @param workingDir - Git working directory
 * @returns `true` when staged changes exist
 */
function stageChanges(workingDir: string): boolean {
  execSync("git add -A", {
    cwd: workingDir,
    maxBuffer: 10 * 1024 * 1024,
  });

  const status = execSync("git status --porcelain", {
    cwd: workingDir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  return status.trim() !== "";
}

/**
 * Create a new commit with the given message when changes are staged.
 *
 * @param message - Commit message
 * @param workingDir - Git working directory
 * @throws When `git commit` fails
 */
function commitChanges(message: string, workingDir: string): void {
  try {
    if (!stageChanges(workingDir)) {
      console.log("No changes to commit");
      return;
    }

    execSync(`git commit -m ${shellEscape(message)}`, {
      cwd: workingDir,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });
    console.log(`Committed: ${message.split("\n")[0]}`);
  } catch (error) {
    throw new Error(`Failed to commit changes: ${error}`);
  }
}

/**
 * Amend the previous commit, appending lines to its message.
 *
 * @param additionalMessage - Text appended after the existing commit body
 * @param workingDir - Git working directory
 * @throws When `git commit --amend` fails
 */
function amendCommit(additionalMessage: string, workingDir: string): void {
  try {
    if (!stageChanges(workingDir)) {
      console.log("No changes to amend");
      return;
    }

    // Get existing commit message
    const existingMessage = execSync("git log -1 --format=%B", {
      cwd: workingDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trimEnd();

    const newMessage = `${existingMessage}\n\n${additionalMessage}`;

    execSync(`git commit --amend -m ${shellEscape(newMessage)}`, {
      cwd: workingDir,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });
    console.log(`Amended commit with: ${additionalMessage.split("\n")[0]}`);
  } catch (error) {
    throw new Error(`Failed to amend commit: ${error}`);
  }
}

/** Escape a string for safe use as a single-quoted shell argument. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Return the branch the working tree's HEAD is currently on, or "" when
 * detached / unknown.
 *
 * @param workingDir - Git working directory
 */
function getCurrentBranch(workingDir: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workingDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Verify the worktree HEAD is on the expected PR branch before we commit or
 * push. A misbehaving test or agent action can leave HEAD on a stray branch
 * (e.g. `tracking-test`); committing/pushing from that state lands work on the
 * wrong branch and can publish junk to the remote. Throws when the branch does
 * not match so the caller can stop instead of operating on a bad state.
 *
 * @param expectedBranch - The PR branch this loop is operating on
 * @param workingDir - Git working directory
 * @throws When HEAD is not on `expectedBranch`
 */
function assertOnExpectedBranch(expectedBranch: string, workingDir: string): void {
  const currentBranch = getCurrentBranch(workingDir);
  if (currentBranch !== expectedBranch) {
    throw new Error(
      `Worktree HEAD is on '${currentBranch || "unknown"}' but expected '${expectedBranch}'. ` +
        "The worktree git state was likely corrupted; refusing to commit/push to avoid " +
        "landing work on the wrong branch or pushing a stray branch.",
    );
  }
}

/**
 * Push local branch changes to `origin`.
 *
 * @param branch - Branch name to push
 * @param workingDir - Git working directory
 * @param forceWithLease - Use `--force-with-lease` (needed after amend)
 * @throws When `git push` fails
 */
function pushChanges(branch: string, workingDir: string, forceWithLease = false): void {
  try {
    // Never push the bare current HEAD; always target the explicit, escaped
    // branch ref so a drifted HEAD cannot publish a stray branch.
    const forceFlag = forceWithLease ? " --force-with-lease" : "";
    execSync(`git push${forceFlag} origin ${shellEscape(branch)}`, {
      cwd: workingDir,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for git hooks output
      encoding: "utf-8",
    });
    console.log(`Pushed changes to ${branch}`);
  } catch (error) {
    throw new Error(`Failed to push changes: ${error}`);
  }
}

/**
 * Persist iteration artifacts (feedback JSON and review prompt) to disk.
 *
 * @param outputDir - Base output directory for the auto-review run
 * @param iteration - Iteration number
 * @param feedback - Parsed review feedback
 * @param prompt - Review prompt sent to the agent
 */
function saveIterationArtifacts(
  outputDir: string,
  iteration: number,
  feedback: ReviewFeedback,
  prompt: string,
): void {
  const iterationDir = join(outputDir, `iteration-${iteration}`);

  if (!existsSync(iterationDir)) {
    mkdirSync(iterationDir, { recursive: true });
  }

  writeFileSync(join(iterationDir, "feedback.json"), JSON.stringify(feedback, null, 2));
  writeFileSync(join(iterationDir, "review-prompt.txt"), prompt);
}

/**
 * Run the iterative PR self-review loop: review, fix, commit, and optionally push.
 *
 * @param options - Repository, branch, harness, iteration limits, and output paths
 * @returns Summary of iterations, success flag, and final feedback history
 */
export async function runAutoReviewLoop(
  options: AutoReviewLoopOptions,
): Promise<AutoReviewLoopResult> {
  const {
    repository,
    prNumber,
    prBranch,
    baseBranch,
    harness,
    executablePath,
    maxIterations = 5,
    minPriority = "medium",
    workingDir,
    outputDir,
    skipPush = false,
  } = options;

  console.log(`\n🔄 Starting automatic PR review loop for #${prNumber}`);
  console.log(`   Base branch: ${baseBranch}`);
  console.log(`   Max iterations: ${maxIterations}`);
  console.log(`   Addressing: ${minPriority}+ priority issues`);
  if (skipPush) {
    console.log(`   Push mode: deferred (will not push during iterations)`);
  }
  console.log("");

  const history: AutoReviewLoopResult["history"] = [];
  let currentFeedback: ReviewFeedback | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(`\n--- Iteration ${iteration}/${maxIterations} ---\n`);

    // Step 1: Get current PR diff
    if (iteration === 1) {
      console.log("📥 Fetching PR diff (initial implementation)...");
    } else {
      console.log(`📥 Fetching updated PR diff (after iteration ${iteration - 1} fixes)...`);
    }
    const prDiff = getPRDiff(baseBranch, workingDir);

    // Step 2: Generate review prompt and request feedback
    if (iteration === 1) {
      console.log("🔍 Requesting initial PR review...");
    } else {
      console.log(
        `🔍 Re-reviewing PR to check if iteration ${iteration - 1} fixes resolved issues...`,
      );
    }
    const reviewPrompt = generateReviewPrompt(repository, prNumber, prDiff, iteration);
    const agentReviewOutput = await runAgentPrompt(
      reviewPrompt,
      workingDir,
      harness,
      executablePath,
    );

    // Step 3: Parse feedback
    console.log("📋 Parsing review feedback...");
    currentFeedback = parseReviewFeedback(agentReviewOutput);

    // Save iteration artifacts
    saveIterationArtifacts(outputDir, iteration, currentFeedback, reviewPrompt);

    console.log(`\n📊 Review Summary: ${currentFeedback.summary}`);
    console.log(`   Total issues: ${currentFeedback.items.length}`);

    // Count by priority
    const priorityCounts = currentFeedback.items.reduce(
      (acc, item) => {
        acc[item.priority] = (acc[item.priority] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    console.log("   Breakdown:", priorityCounts);

    // Log each issue with priority
    if (currentFeedback.items.length > 0) {
      console.log("   Issues:");
      for (const item of currentFeedback.items) {
        const location = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : "";
        console.log(`     [${item.priority}]${location}: ${item.issue}`);
      }
    }

    // Show comparison to previous iteration
    if (iteration > 1 && history.length > 0) {
      const previousFeedback = history[history.length - 1].feedback;
      const previousTotal = previousFeedback.items.length;
      const currentTotal = currentFeedback.items.length;
      const delta = currentTotal - previousTotal;

      if (delta < 0) {
        console.log(`   ✅ ${Math.abs(delta)} fewer issue(s) than iteration ${iteration - 1}`);
      } else if (delta > 0) {
        console.log(
          `   ⚠️  ${delta} more issue(s) than iteration ${iteration - 1} (fixes may have introduced new issues)`,
        );
      } else {
        console.log(`   ℹ️  Same number of issues as iteration ${iteration - 1}`);
      }
    }

    // Step 4: Filter issues to address
    const toAddress = filterByPriority(currentFeedback.items, minPriority);

    if (toAddress.length === 0) {
      console.log("\n✅ No important issues to address. Review loop complete!");
      history.push({
        iteration,
        feedback: currentFeedback,
        addressed: [],
      });
      break;
    }

    console.log(`\n🔧 Addressing ${toAddress.length} ${minPriority}+ priority issue(s)...\n`);

    // Step 5: Generate fix prompt and run Agent to address issues
    const fixPrompt = generateFixPrompt(toAddress, iteration);
    console.log("🤖 Running Agent to address feedback...");

    try {
      await runAgentPrompt(fixPrompt, workingDir, harness, executablePath);
    } catch (error) {
      console.error(`⚠️  Error running Agent for fixes: ${error}`);
      // Continue to next iteration even if fixes fail
    }

    // Safety: ensure the worktree is still on the PR branch before we commit or
    // push. If the agent or a hook drifted HEAD onto a stray branch, stop the
    // loop rather than landing work on the wrong branch or pushing junk.
    try {
      assertOnExpectedBranch(prBranch, workingDir);
    } catch (error) {
      console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
      break;
    }

    // Step 6: Commit changes (first iteration creates, subsequent amend)
    try {
      if (iteration === 1) {
        commitChanges("fix: address PR review feedback", workingDir);
      } else {
        amendCommit(`Iteration ${iteration}: address additional review feedback`, workingDir);
      }
    } catch (error) {
      console.log(`⚠️  No changes committed: ${error}`);
    }

    // Step 7: Push changes (unless skipPush is enabled)
    // After amending (iteration 2+), force-with-lease is needed
    if (!skipPush) {
      console.log("📤 Pushing changes...");
      pushChanges(prBranch, workingDir, iteration > 1);
    } else {
      console.log("⏸️  Skipping push (deferred mode)");
    }

    // Record history
    history.push({
      iteration,
      feedback: currentFeedback,
      addressed: toAddress,
    });

    // Check if approved
    if (currentFeedback.approved) {
      console.log("\n✅ PR approved! Review loop complete.");
      break;
    }

    // Wait a moment for GitHub to process the push before next iteration
    // (only needed if we're actually pushing)
    if (!skipPush && iteration < maxIterations) {
      console.log("\n⏳ Waiting for GitHub to process changes...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const success = Boolean(
    currentFeedback?.approved ||
    (currentFeedback?.items && filterByPriority(currentFeedback.items, minPriority).length === 0),
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`🏁 Auto-review loop finished after ${history.length} iteration(s)`);
  console.log(`   Status: ${success ? "✅ Success" : "⚠️  Incomplete"}`);
  console.log(`${"=".repeat(60)}\n`);

  return {
    iterations: history.length,
    success,
    finalFeedback: currentFeedback!,
    history,
  };
}
