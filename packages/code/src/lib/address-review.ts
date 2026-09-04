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
} from "@devintern/agent-harness";
import { readFileSync } from "fs";
import { buildHeadlessAgentArgs, HEADLESS_AGENT_STDIO } from "./agent-spawn";
import { resolveAgentModel } from "./agent-model";
import { getSandbox } from "./sandbox";
import { GitHubReviewsClient, resolveGitHubAuthMode } from "./github-reviews";
import { GitHubAppAuth } from "./github-app-auth";
import { beginRun, endRun, recordRunStage } from "./run-recorder";
import { formatCiFixPrompt, formatReviewPrompt } from "./review-formatter";
import type { CiFailureFeedback } from "./review-formatter";
import { GIT_CLEAN_ARGS, Utils } from "./utils";
import { isCommitAlreadyComplete, runAgentHarnessToFixGitHook } from "./git-hook-fixer";
import { botMentionCandidates, mentionsAnyBot, mentionsBot } from "./mention-sweep-acquirer";
import { WorkerState } from "./worker-state";
import type {
  ProcessedReviewComment,
  ProcessedReviewFeedback,
  ProcessedConversationComment,
} from "../types/github-webhooks";

export interface AddressReviewOptions {
  noPush?: boolean;
  noReply?: boolean;
  verbose?: boolean;
  /** Internal worker mode: fix the failures described in this JSON file. */
  ciFeedbackPath?: string;
}

function readCiFeedbackFile(filePath: string): CiFailureFeedback {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CiFailureFeedback;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.failures)) {
    throw new Error(`Invalid CI feedback file: ${filePath}`);
  }
  return parsed;
}

interface ParsedPRUrl {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Parse a GitHub PR URL into its components.
 *
 * @param url - GitHub pull request URL (e.g. `https://github.com/owner/repo/pull/123`)
 * @returns Owner, repository name, and PR number
 * @throws When the URL does not match the expected GitHub PR format
 */
function parsePRUrl(url: string): ParsedPRUrl {
  // Match URLs like:
  // https://github.com/owner/repo/pull/123
  // https://github.com/owner/repo/pull/123/files
  // https://github.com/owner/repo/pull/123#discussion_r123456
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

  if (!match) {
    throw new Error(
      `Invalid GitHub PR URL: ${url}\n` + `Expected format: https://github.com/owner/repo/pull/123`,
    );
  }

  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
}

/**
 * Metadata of the review a run will act on.
 */
interface FeedbackReview {
  reviewId: number;
  reviewer: string;
  body: string | null;
  submittedAt: string;
  /** GitHub REST review state (`CHANGES_REQUESTED` or `COMMENTED`). */
  state: string;
}

/**
 * Get the review a run should act on: the latest `changes_requested` review,
 * or — when no `changes_requested` reviews exist — the latest `commented`
 * review. A `commented` pick is only acted on when the bot is mentioned
 * (the gate runs in {@link addressReview} once the comments are fetched);
 * `changes_requested` reviews are always addressed.
 *
 * @param client - GitHub reviews API client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param prNumber - Pull request number
 * @returns Review metadata, or `null` if none exist
 */
async function getLatestFeedbackReview(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<FeedbackReview | null> {
  // Fetch all reviews for the PR using the client
  const reviews = await client.getReviews(owner, repo, prNumber);

  const byNewest = (a: { submitted_at: string }, b: { submitted_at: string }) =>
    new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime();

  const changesRequestedReviews = reviews
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .sort(byNewest);

  if (changesRequestedReviews.length > 0) {
    const latest = changesRequestedReviews[0];
    return {
      reviewId: latest.id,
      reviewer: latest.user.login,
      body: latest.body,
      submittedAt: latest.submitted_at,
      state: latest.state,
    };
  }

  const commentedReviews = reviews.filter((r) => r.state === "COMMENTED").sort(byNewest);
  if (commentedReviews.length === 0) {
    return null;
  }

  const latest = commentedReviews[0];
  return {
    reviewId: latest.id,
    reviewer: latest.user.login,
    body: latest.body,
    submittedAt: latest.submitted_at,
    state: latest.state,
  };
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

  return new Promise((resolve) => {
    (async () => {
      // Use high default like regular development (500 turns)
      const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);

      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
      const runOptions = {
        maxTurns,
        skipPermissions: true,
        workingDir: workDir,
        model: resolveAgentModel(),
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
        const maxTurnsReached = detectMaxTurnsReached(
          stdoutOutput,
          stderrOutput,
          harness.supportsMaxTurns === true,
        );
        const output = stdoutOutput + stderrOutput;

        resolve({
          success: code === 0 && !maxTurnsReached && !timedOut && !usageLimited,
          output: timedOut ? output + `\n\nTimed out after ${timeoutMinutes} minutes` : output,
          maxTurnsReached,
        });
      });
    })().catch((error) => {
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
async function markCommentsAddressed(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  comments: ProcessedReviewComment[],
  conversationComments: ProcessedConversationComment[],
): Promise<void> {
  if (comments.length === 0 && conversationComments.length === 0) {
    return;
  }

  const repoSlug = `${owner}/${repo}`;
  const workerState = new WorkerState();
  try {
    // Replies included: the local marker is per-comment, so reply threads
    // dedupe too (reactions skip them — GitHub threads under the root).
    workerState.markCommentsAddressed(
      repoSlug,
      "review",
      comments.map((comment) => comment.id),
    );
    workerState.markCommentsAddressed(
      repoSlug,
      "conversation",
      conversationComments.map((comment) => comment.id),
    );
  } finally {
    workerState.close();
  }

  const reactionFailureHint = (message: string): string =>
    message.includes("not accessible by integration")
      ? `${message} (the App installation lacks reaction permissions; dedupe is local, so this is cosmetic only)`
      : message;

  // 🎉 reactions: visual feedback only. Skipped for replies so the thread
  // root carries the single human-readable marker.
  if (comments.length > 0) {
    console.log(`   Marking ${comments.length} review comment(s) as addressed...`);

    let successCount = 0;
    for (const comment of comments) {
      if (comment.isReply) continue;
      try {
        await client.addReactionToComment(owner, repo, comment.id, "hooray");
        successCount++;
      } catch (error) {
        console.warn(
          `   ⚠️  Could not add 🎉 to review comment ${comment.id}: ${reactionFailureHint((error as Error).message)}`,
        );
      }
    }
    if (successCount > 0) {
      console.log(`   🎉 Reacted to ${successCount} review comment(s) (visual feedback)`);
    }
  }

  if (conversationComments.length > 0) {
    console.log(
      `   Marking ${conversationComments.length} conversation comment(s) as addressed...`,
    );

    let successCount = 0;
    for (const comment of conversationComments) {
      try {
        await client.addReactionToIssueComment(owner, repo, comment.id, "hooray");
        successCount++;
      } catch (error) {
        console.warn(
          `   ⚠️  Could not add 🎉 to conversation comment ${comment.id}: ${reactionFailureHint((error as Error).message)}`,
        );
      }
    }
    if (successCount > 0) {
      console.log(`   🎉 Reacted to ${successCount} conversation comment(s) (visual feedback)`);
    }
  }
}

/**
 * Fetch PR review feedback and run an agent to address unaddressed comments.
 *
 * @param prUrl - Full GitHub pull request URL
 * @param options - Control push, comment marking, and verbosity
 * @throws When the PR is not open, worktree setup fails, or agent/commit/push fails
 */
export async function addressReview(
  prUrl: string,
  options: AddressReviewOptions = {},
): Promise<void> {
  const { noPush = false, noReply = false, verbose = false } = options;

  console.log("🔍 Parsing PR URL...");
  const { owner, repo, prNumber } = parsePRUrl(prUrl);
  const repoSlug = `${owner}/${repo}`;
  console.log(`   Repository: ${owner}/${repo}`);
  console.log(`   PR #${prNumber}`);

  // Get GitHub App author info if available (for commit attribution)
  let gitAuthor: { name: string; email: string } | undefined;
  if (!process.env.GITHUB_TOKEN) {
    const githubAppAuth = GitHubAppAuth.fromEnvironment();
    if (githubAppAuth) {
      try {
        gitAuthor = await githubAppAuth.getGitAuthor();
        if (verbose) {
          console.log(`🤖 Commits will be authored by: ${gitAuthor.name}`);
        }
      } catch (error) {
        if (verbose) {
          console.warn(`⚠️  Could not get GitHub App author info: ${(error as Error).message}`);
          console.log("   Commits will use local git config instead.");
        }
      }
    }
  }

  // Direct/no-relay runs prefer the customer-owned App so its bot identity
  // resolves. Relay-backed workspace subprocesses receive a token-only mode
  // override plus the central App's static mention alias.
  const githubClient = new GitHubReviewsClient({
    authMode: resolveGitHubAuthMode("app-first"),
  });

  // Get PR details
  console.log("\n📋 Fetching PR details...");
  const pr = await githubClient.getPullRequest(owner, repo, prNumber);
  console.log(`   Title: ${pr.title}`);
  console.log(`   Branch: ${pr.head.ref}`);
  console.log(`   State: ${pr.state}`);

  if (pr.state !== "open") {
    throw new Error(`PR is ${pr.state}, not open. Cannot address review.`);
  }

  const ciFeedback = options.ciFeedbackPath
    ? readCiFeedbackFile(options.ciFeedbackPath)
    : undefined;
  let processedComments: ProcessedReviewComment[] = [];
  let processedConversationComments: ProcessedConversationComment[] = [];
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
    // Get latest actionable review (changes_requested, or commented when no
    // changes_requested reviews exist — the commented pick is mention-gated
    // after the comments below are fetched).
    console.log("\n🔎 Looking for actionable review feedback...");
    const review = await getLatestFeedbackReview(githubClient, owner, repo, prNumber);

    if (!review) {
      console.log("✅ No pending changes_requested or commented reviews found.");
      return;
    }

    console.log(`   Found ${review.state.toLowerCase()} review from @${review.reviewer}`);

    // Fetch ALL review comments for the PR (not just from this review)
    console.log("\n📥 Fetching review comments...");
    const rawComments = await githubClient.getPullRequestReviewComments(owner, repo, prNumber);

    // Resolve the bot identity once: it decides whether a commented review run
    // triggers at all and whether a stray inline comment is an explicit ask.
    // Aliases (GITHUB_BOT_ALIASES) extend the resolvable identity — e.g. the
    // relay App's login, whose private key is not available locally.
    const botName = await githubClient.getBotUsername(owner, repo);
    const botNames = botMentionCandidates(botName);

    // Local dedupe: which comments this worker already addressed. GitHub
    // reactions are visual feedback only and carry no gating meaning.
    const workerState = new WorkerState();

    const addressedCommentIds = new Set(
      rawComments
        .filter((comment) => workerState.isCommentAddressed(repoSlug, "review", comment.id))
        .map((comment) => comment.id),
    );

    // Scope comments to this run: the chosen review's own threads plus explicit
    // @mentions of the bot. Feedback that was never asked for (a stray comment
    // from another review) stays unactioned until its author mentions the bot
    // or submits their own actionable review.
    const reviewThreadRootIds = new Set(
      rawComments.filter((c) => c.pull_request_review_id === review.reviewId).map((c) => c.id),
    );
    const rootIdOf = (comment: (typeof rawComments)[number]): number | undefined => {
      let current: (typeof rawComments)[number] | undefined = comment;
      const visited = new Set<number>();
      while (current?.in_reply_to_id !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        current = rawComments.find((c) => c.id === current?.in_reply_to_id);
      }
      return current?.id;
    };

    const unaddressedComments = rawComments.filter((c) => !addressedCommentIds.has(c.id));
    processedComments = unaddressedComments
      .filter((c) => {
        const rootId = rootIdOf(c);
        if (rootId !== undefined && reviewThreadRootIds.has(rootId)) {
          return true;
        }
        return mentionsAnyBot(c.body, botNames);
      })
      .map((c) => ({
        id: c.id,
        path: c.path,
        line: c.line ?? c.original_line,
        side: c.side,
        diffHunk: c.diff_hunk,
        body: c.body,
        reviewer: c.user.login,
        isReply: c.in_reply_to_id !== undefined,
      }));

    const totalComments = rawComments.length;
    const alreadyAddressed = totalComments - unaddressedComments.length;
    const outOfScope = unaddressedComments.length - processedComments.length;

    console.log(`   Found ${totalComments} comment(s)`);
    if (alreadyAddressed > 0) {
      console.log(`   ${alreadyAddressed} already addressed (skipping)`);
    }
    if (outOfScope > 0) {
      console.log(
        `   ${outOfScope} unaddressed but out of scope for this run ` +
          "(different review thread and no bot @mention — not actioned)",
      );
    }
    console.log(`   ${processedComments.length} remaining to address`);

    // Fetch conversation comments (issue comments)
    console.log("\n💬 Fetching conversation comments...");
    const rawIssueComments = await githubClient.getIssueComments(owner, repo, prNumber);

    // Filter to only include comments from the reviewer, created after the review
    const reviewSubmittedAt = new Date(review.submittedAt);
    const reviewerIssueComments = rawIssueComments.filter(
      (c) => c.user.login === review.reviewer && new Date(c.created_at) >= reviewSubmittedAt,
    );

    // Check which issue comments were already addressed (local dedupe)
    const addressedIssueCommentIds = new Set(
      reviewerIssueComments
        .filter((comment) => workerState.isCommentAddressed(repoSlug, "conversation", comment.id))
        .map((comment) => comment.id),
    );
    workerState.close();

    processedConversationComments = reviewerIssueComments
      .filter((c) => !addressedIssueCommentIds.has(c.id))
      .map((c) => ({
        id: c.id,
        body: c.body,
        author: c.user.login,
        createdAt: c.created_at,
      }));

    const totalIssueComments = reviewerIssueComments.length;
    const alreadyAddressedIssue = totalIssueComments - processedConversationComments.length;

    console.log(`   Found ${totalIssueComments} conversation comment(s) from reviewer`);
    if (alreadyAddressedIssue > 0) {
      console.log(`   ${alreadyAddressedIssue} already addressed (skipping)`);
    }
    console.log(`   ${processedConversationComments.length} remaining to address`);

    // A commented review is informational by nature: only act on it when a bot
    // identity is explicitly mentioned — in the review body itself or in one of
    // the comments beneath it. changes_requested reviews are always addressed.
    // Fails closed when no bot identity is configured at all.
    if (review.state === "COMMENTED") {
      const mentionSources = [
        review.body,
        ...processedComments.map((c) => c.body),
        ...processedConversationComments.map((c) => c.body),
      ];
      const matchedBot = botNames.find((name) =>
        mentionSources.some((body) => mentionsBot(body, name)),
      );
      if (!matchedBot) {
        if (botNames.length === 0) {
          console.log(
            "\n⏭️  Latest review is commented, but no bot identity is configured to verify @mentions — skipping.",
          );
          console.log(
            "   Configure a GitHub App or set GITHUB_BOT_ALIASES (e.g. the relay App's login).",
          );
        } else {
          const names = botNames.map((name) => `@${name}`).join(" or ");
          console.log(
            `\n⏭️  Latest review is commented and nothing in it mentions ${names} — skipping.`,
          );
        }
        console.log(
          "   Commented reviews are addressed only when they mention the bot; changes_requested reviews are always addressed.",
        );
        console.log(`   View PR: ${prUrl}`);
        return;
      }
      if (verbose && botNames.length > 0) {
        console.log(
          `   💬 Bot mention detected (${botNames.map((name) => `@${name}`).join(", ")}); addressing.`,
        );
      }
    }

    // If no comments remaining (neither review nor conversation), we're done
    if (processedComments.length === 0 && processedConversationComments.length === 0) {
      console.log("\n✅ All review and conversation comments have been addressed already.");
      console.log(`   View PR: ${prUrl}`);
      return;
    }

    // Build feedback object
    const feedback: ProcessedReviewFeedback = {
      prNumber,
      prTitle: pr.title,
      repository: `${owner}/${repo}`,
      branch: pr.head.ref,
      reviewer: review.reviewer,
      reviewState: review.state.toLowerCase() as ProcessedReviewFeedback["reviewState"],
      reviewBody: review.body,
      comments: processedComments,
      conversationComments:
        processedConversationComments.length > 0 ? processedConversationComments : undefined,
    };

    // Run record: begun only once there is actual feedback to handle, so
    // no-op invocations (nothing unaddressed) do not create run rows.
    beginRun({
      origin: "pr_mention",
      repo: `${owner}/${repo}`,
      prNumber,
      prUrl,
      branch: pr.head.ref,
      harness: resolveHarness({ warnDeprecated: false }).harness.name,
    });
    recordRunStage("change_request", {
      status: "succeeded",
      summary: `addressing ${processedComments.length} review comment(s) and ${processedConversationComments.length} conversation comment(s) from @${review.reviewer}`,
      detail: {
        reviewer: review.reviewer,
        reviewComments: processedComments.length,
        conversationComments: processedConversationComments.length,
      },
    });
    prompt = formatReviewPrompt(feedback);
    commitSummary = `Address review feedback from ${feedback.reviewer}`;
  }

  // Prepare the review worktree
  console.log(`\n🌿 Preparing review worktree for branch: ${pr.head.ref}`);

  // Check if we're in a git repo
  const isGitRepo = await Utils.isGitRepository();
  if (!isGitRepo) {
    throw new Error("Not in a git repository. Please run this command from within the repository.");
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
      console.log("\n💬 Marking comments as addressed...");

      await markCommentsAddressed(
        githubClient,
        owner,
        repo,
        processedComments,
        processedConversationComments,
      );
    } else if (!ciFeedback && noReply) {
      console.log("\n⏭️  Skipping marking comments (--no-reply flag)");
    }

    console.log(
      ciFeedback
        ? `\n✅ Successfully pushed a CI fix for PR #${prNumber}`
        : `\n✅ Successfully addressed review for PR #${prNumber}`,
    );
    console.log(`   View PR: ${prUrl}`);
    endRun("succeeded");
    return;
  } catch (error) {
    endRun("failed", (error as Error).message);
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
