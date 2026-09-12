import type { ChangeRequestIdentity } from "../index";
import type { ReviewAdapter } from "../review-provider";
import { WorkerState } from "../../worker-state";
import type {
  ProcessedReviewComment,
  ProcessedReviewFeedback,
  ProcessedConversationComment,
} from "../../../types/github-webhooks";
import { GitHubReviewsClient, resolveGitHubAuthMode } from "./reviews";
import { GitHubAppAuth } from "./app-auth";
import { botMentionCandidates, mentionsAnyBot, mentionsBot } from "../../acquirers/mention-sweep";
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
 * (the gate runs after the comments are fetched);
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

export async function createGitHubReviewAdapter(
  identity: ChangeRequestIdentity,
  verbose: boolean,
): Promise<ReviewAdapter> {
  const [owner = "", repo = ""] = identity.projectPath.split("/");
  const repoSlug = identity.projectPath;
  const prNumber = identity.number;
  const prUrl = identity.webUrl;
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

  console.log("\n📋 Fetching PR details...");
  const githubClient = new GitHubReviewsClient({ authMode: resolveGitHubAuthMode("app-first") });
  const pr = await githubClient.getPullRequest(owner, repo, prNumber);
  if (pr.state !== "open") throw new Error(`PR is ${pr.state}, not open. Cannot address review.`);
  let processedComments: ProcessedReviewComment[] = [];
  let processedConversationComments: ProcessedConversationComment[] = [];
  return {
    change: pr,
    gitAuthor,
    async loadFeedback() {
      // Get latest actionable review (changes_requested, or commented when no
      // changes_requested reviews exist — the commented pick is mention-gated
      // after the comments below are fetched).
      console.log("\n🔎 Looking for actionable review feedback...");
      const review = await getLatestFeedbackReview(githubClient, owner, repo, prNumber);

      if (!review) {
        console.log("✅ No pending changes_requested or commented reviews found.");
        return null;
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
          return null;
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
        return null;
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

      return {
        feedback,
        stageSummary: `addressing ${processedComments.length} review comment(s) and ${processedConversationComments.length} conversation comment(s) from @${review.reviewer}`,
        stageDetail: {
          reviewer: review.reviewer,
          reviewComments: processedComments.length,
          conversationComments: processedConversationComments.length,
        },
      };
    },
    async beforePush() {},
    async acknowledge() {
      console.log("\n💬 Marking comments as addressed...");

      await markCommentsAddressed(
        githubClient,
        owner,
        repo,
        processedComments,
        processedConversationComments,
      );
    },
  };
}
