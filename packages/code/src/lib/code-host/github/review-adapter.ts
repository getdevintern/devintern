import type { ChangeRequestIdentity } from "../index";
import type { ReviewAdapter } from "../review-provider";
import { WorkerState } from "../../state/worker-state";
import type {
  ProcessedReviewComment,
  ProcessedReviewFeedback,
  ProcessedConversationComment,
} from "../../../types/github-webhooks";
import { GitHubReviewsClient, resolveGitHubAuthMode } from "./reviews";
import { GitHubAppAuth } from "./app-auth";
import { botMentionCandidates, mentionsAnyBot, mentionsBot } from "../../acquirers/mention-sweep";
import { isBotAuthored } from "../../review/mention-trigger";
import type { MentionTrigger } from "../../review/mention-trigger";
import { isGitHubNotFound } from "./github-errors";
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
 * A run triggered by a comment @mention passes `changesRequestedOnly`: the
 * mention is the instruction, and an unrelated `commented` review must not
 * ride along (a commented review that mentions the bot triggers its own run).
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
  changesRequestedOnly = false,
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

  if (changesRequestedOnly) {
    return null;
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
  reviewBodyIds: number[] = [],
): Promise<void> {
  if (comments.length === 0 && conversationComments.length === 0 && reviewBodyIds.length === 0) {
    return;
  }

  const repoSlug = `${owner}/${repo}`;
  const workerState = new WorkerState();
  try {
    // A review body has no reaction API; the local marker is its only dedupe.
    workerState.markCommentsAddressed(repoSlug, "review_body", reviewBodyIds);
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

/** The comment or review that @mentioned the bot, as fetched by the run. */
interface MentionItem {
  trigger: MentionTrigger;
  author: string;
  body: string | null;
  createdAt: string;
  /** Set when the mention is a review: that review drives the run. */
  review?: FeedbackReview;
}

const MENTION_KIND_LABEL: Record<MentionTrigger["kind"], string> = {
  issue_comment: "conversation comment",
  review_comment: "review comment",
  review: "review",
};

/** Raw comment or review payload, as far as {@link fetchMention} reads it. */
interface RawMention {
  id: number;
  body: string | null;
  user: { login: string; type?: string };
  created_at?: string;
  submitted_at?: string;
  state?: string;
  issue_url?: string;
  pull_request_url?: string;
}

/** Fetch the raw mention (comment or review) for {@link loadMention}. */
async function fetchMention(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  prNumber: number,
  trigger: MentionTrigger,
): Promise<MentionItem & { user: RawMention["user"]; prUrl?: string }> {
  const base = `/repos/${owner}/${repo}`;
  const path =
    trigger.kind === "issue_comment"
      ? `${base}/issues/comments/${trigger.id}`
      : trigger.kind === "review_comment"
        ? `${base}/pulls/comments/${trigger.id}`
        : `${base}/pulls/${prNumber}/reviews/${trigger.id}`;
  const { data } = await client.conditionalGet<RawMention>(path, owner, repo);
  if (!data?.user) {
    throw new Error(`GitHub returned no ${MENTION_KIND_LABEL[trigger.kind]} ${trigger.id}`);
  }
  const createdAt = data.submitted_at ?? data.created_at ?? "";
  return {
    trigger,
    user: data.user,
    author: data.user.login,
    body: data.body,
    createdAt,
    prUrl: data.issue_url ?? data.pull_request_url,
    ...(trigger.kind === "review"
      ? {
          review: {
            reviewId: data.id,
            reviewer: data.user.login,
            body: data.body,
            submittedAt: createdAt,
            state: data.state ?? "COMMENTED",
          },
        }
      : {}),
  };
}

/**
 * Fetch the mention that triggered this run. Returns `null` (logged) when it
 * no longer exists, belongs to another PR, or was written by the bot or the
 * worker itself: acting on those would loop the agent on its own output.
 */
async function loadMention(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  prNumber: number,
  trigger: MentionTrigger,
  botNames: string[],
): Promise<MentionItem | null> {
  const label = MENTION_KIND_LABEL[trigger.kind];
  let item: Awaited<ReturnType<typeof fetchMention>>;
  try {
    item = await fetchMention(client, owner, repo, prNumber, trigger);
  } catch (error) {
    if (isGitHubNotFound(error)) {
      console.log(`⏭️  The ${label} that mentioned the bot (${trigger.id}) no longer exists.`);
      return null;
    }
    throw error;
  }
  const match = item.prUrl ? /\/(?:pulls|issues)\/(\d+)$/.exec(item.prUrl) : null;
  if (match && Number(match[1]) !== prNumber) {
    console.log(`⏭️  The ${label} ${trigger.id} belongs to another PR (#${match[1]}); skipping.`);
    return null;
  }
  if (isBotAuthored({ user: item.user, body: item.body }, botNames)) {
    console.log(`⏭️  The ${label} ${trigger.id} was written by the bot itself; not acting on it.`);
    return null;
  }
  const { user: _user, prUrl: _prUrl, ...mentionItem } = item;
  return mentionItem;
}

export interface GitHubReviewAdapterOptions {
  /** The @mention that triggered this run; addressed as feedback itself. */
  mention?: MentionTrigger;
}

type RawReviewComment = Awaited<
  ReturnType<GitHubReviewsClient["getPullRequestReviewComments"]>
>[number];

/**
 * Pick the review comments this run addresses: the chosen review's own
 * threads, the mentioned comment, and any comment that @mentions the bot.
 */
function selectReviewComments(
  unaddressed: RawReviewComment[],
  all: RawReviewComment[],
  review: FeedbackReview | null,
  mentionedCommentId: number | undefined,
  botNames: string[],
): ProcessedReviewComment[] {
  const reviewThreadRootIds = new Set(
    review ? all.filter((c) => c.pull_request_review_id === review.reviewId).map((c) => c.id) : [],
  );
  const rootIdOf = (comment: RawReviewComment): number | undefined => {
    let current: RawReviewComment | undefined = comment;
    const visited = new Set<number>();
    while (current?.in_reply_to_id !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      current = all.find((c) => c.id === current?.in_reply_to_id);
    }
    return current?.id;
  };
  return unaddressed
    .filter((c) => {
      const rootId = rootIdOf(c);
      if (rootId !== undefined && reviewThreadRootIds.has(rootId)) {
        return true;
      }
      return c.id === mentionedCommentId || mentionsAnyBot(c.body, botNames);
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
}

/**
 * Whether a `commented` review (without a mention trigger) mentions the bot
 * anywhere in scope; logs why not. Fails closed without a bot identity.
 */
function commentedReviewMentionsBot(
  sources: Array<string | null>,
  botNames: string[],
  prUrl: string,
  verbose: boolean,
): boolean {
  const matchedBot = botNames.find((name) => sources.some((body) => mentionsBot(body, name)));
  if (matchedBot) {
    if (verbose) {
      console.log(
        `   💬 Bot mention detected (${botNames.map((name) => `@${name}`).join(", ")}); addressing.`,
      );
    }
    return true;
  }
  if (botNames.length === 0) {
    console.log(
      "\n⏭️  Latest review is commented, but no bot identity is configured to verify @mentions — skipping.",
    );
    console.log(
      "   Configure a GitHub App or set GITHUB_BOT_ALIASES (e.g. the relay App's login).",
    );
  } else {
    const names = botNames.map((name) => `@${name}`).join(" or ");
    console.log(`\n⏭️  Latest review is commented and nothing in it mentions ${names} — skipping.`);
  }
  console.log(
    "   Commented reviews are addressed only when they mention the bot; changes_requested reviews are always addressed.",
  );
  console.log(`   View PR: ${prUrl}`);
  return false;
}

/** Log which review and/or mention drives this run. */
function logFeedbackSources(review: FeedbackReview | null, mentionItem: MentionItem | null): void {
  if (mentionItem) {
    console.log(
      `   Found @mention in a ${MENTION_KIND_LABEL[mentionItem.trigger.kind]} from @${mentionItem.author}`,
    );
  }
  if (review && review !== mentionItem?.review) {
    console.log(`   Found ${review.state.toLowerCase()} review from @${review.reviewer}`);
  }
}

/**
 * Conversation comments in scope: the reviewer's comments posted after the
 * review, plus the mention itself when it is a conversation comment.
 */
async function collectConversationCandidates(
  client: GitHubReviewsClient,
  owner: string,
  repo: string,
  prNumber: number,
  review: FeedbackReview | null,
  mentionItem: MentionItem | null,
): Promise<Array<{ id: number; body: string; user: { login: string }; created_at: string }>> {
  const candidates: Array<{
    id: number;
    body: string;
    user: { login: string };
    created_at: string;
  }> = [];
  if (review) {
    const rawIssueComments = await client.getIssueComments(owner, repo, prNumber);
    const reviewSubmittedAt = new Date(review.submittedAt);
    candidates.push(
      ...rawIssueComments.filter(
        (c) => c.user.login === review.reviewer && new Date(c.created_at) >= reviewSubmittedAt,
      ),
    );
  }
  if (
    mentionItem?.trigger.kind === "issue_comment" &&
    !candidates.some((c) => c.id === mentionItem.trigger.id)
  ) {
    candidates.push({
      id: mentionItem.trigger.id,
      body: mentionItem.body ?? "",
      user: { login: mentionItem.author },
      created_at: mentionItem.createdAt,
    });
  }
  return candidates;
}

/** The mentioning review's id while its non-empty body is still unaddressed. */
function pendingReviewBodyIds(
  workerState: WorkerState,
  repoSlug: string,
  mentionItem: MentionItem | null,
): number[] {
  const review = mentionItem?.review;
  if (!review?.body?.trim()) return [];
  return workerState.isCommentAddressed(repoSlug, "review_body", review.reviewId)
    ? []
    : [review.reviewId];
}

/** Assemble the feedback a run addresses plus its run-record stage. */
function buildFeedbackSelection(input: {
  pr: { title: string; head: { ref: string } };
  prNumber: number;
  repoSlug: string;
  review: FeedbackReview | null;
  mentionItem: MentionItem | null;
  comments: ProcessedReviewComment[];
  conversationComments: ProcessedConversationComment[];
}): NonNullable<Awaited<ReturnType<ReviewAdapter["loadFeedback"]>>> {
  const { review, mentionItem, comments, conversationComments } = input;
  const reviewer = review?.reviewer ?? mentionItem?.author ?? "unknown";
  const feedback: ProcessedReviewFeedback = {
    prNumber: input.prNumber,
    prTitle: input.pr.title,
    repository: input.repoSlug,
    branch: input.pr.head.ref,
    reviewer,
    reviewState: (review?.state.toLowerCase() ??
      "commented") as ProcessedReviewFeedback["reviewState"],
    reviewBody: review?.body ?? null,
    comments,
    conversationComments: conversationComments.length > 0 ? conversationComments : undefined,
  };
  const mentionSummary = mentionItem
    ? ` (triggered by an @mention in a ${MENTION_KIND_LABEL[mentionItem.trigger.kind]})`
    : "";
  return {
    feedback,
    stageSummary: `addressing ${comments.length} review comment(s) and ${conversationComments.length} conversation comment(s) from @${reviewer}${mentionSummary}`,
    stageDetail: {
      reviewer,
      reviewComments: comments.length,
      conversationComments: conversationComments.length,
      ...(mentionItem
        ? { mention: { kind: mentionItem.trigger.kind, id: mentionItem.trigger.id } }
        : {}),
    },
  };
}

export async function createGitHubReviewAdapter(
  identity: ChangeRequestIdentity,
  verbose: boolean,
  options: GitHubReviewAdapterOptions = {},
): Promise<ReviewAdapter> {
  const [owner = "", repo = ""] = identity.projectPath.split("/");
  const repoSlug = identity.projectPath;
  const prNumber = identity.number;
  const prUrl = identity.webUrl;
  const { mention } = options;
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
  let processedReviewBodyIds: number[] = [];
  return {
    change: pr,
    gitAuthor,
    async loadFeedback() {
      console.log("\n🔎 Looking for actionable review feedback...");

      // Resolve the bot identity once: it decides whether a commented review run
      // triggers at all and whether a stray inline comment is an explicit ask.
      // Aliases (GITHUB_BOT_ALIASES) extend the resolvable identity — e.g. the
      // relay App's login, whose private key is not available locally.
      const botName = await githubClient.getBotUsername(owner, repo);
      const botNames = botMentionCandidates(botName);

      // A mention-triggered run addresses the mention itself, even on a PR
      // with no reviews (the worker already checked the author's push access).
      const mentionItem = mention
        ? await loadMention(githubClient, owner, repo, prNumber, mention, botNames)
        : null;
      if (mention && !mentionItem) {
        return null;
      }

      // Get latest actionable review (changes_requested, or commented when no
      // changes_requested reviews exist — the commented pick is mention-gated
      // after the comments below are fetched). A review mention is that review.
      const review: FeedbackReview | null =
        mentionItem?.review ??
        (await getLatestFeedbackReview(githubClient, owner, repo, prNumber, Boolean(mentionItem)));

      if (!review && !mentionItem) {
        console.log("✅ No pending changes_requested or commented reviews found.");
        return null;
      }

      logFeedbackSources(review, mentionItem);

      // Fetch ALL review comments for the PR (not just from this review)
      console.log("\n📥 Fetching review comments...");
      const rawComments = await githubClient.getPullRequestReviewComments(owner, repo, prNumber);

      // Local dedupe: which comments this worker already addressed. GitHub
      // reactions are visual feedback only and carry no gating meaning.
      const workerState = new WorkerState();

      const unaddressedComments = rawComments.filter(
        (comment) => !workerState.isCommentAddressed(repoSlug, "review", comment.id),
      );
      // Scope comments to this run: the chosen review's own threads plus explicit
      // @mentions of the bot. Feedback that was never asked for (a stray comment
      // from another review) stays unactioned until its author mentions the bot
      // or submits their own actionable review.
      processedComments = selectReviewComments(
        unaddressedComments,
        rawComments,
        review,
        mentionItem?.trigger.kind === "review_comment" ? mentionItem.trigger.id : undefined,
        botNames,
      );

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

      // Conversation comments (issue comments): the reviewer's comments after
      // the review, plus the mention itself when it is a conversation comment.
      console.log("\n💬 Fetching conversation comments...");
      const candidateIssueComments = await collectConversationCandidates(
        githubClient,
        owner,
        repo,
        prNumber,
        review,
        mentionItem,
      );

      processedConversationComments = candidateIssueComments
        .filter((c) => !workerState.isCommentAddressed(repoSlug, "conversation", c.id))
        .map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user.login,
          createdAt: c.created_at,
        }));
      // A mentioning review's own body is feedback too, until it is addressed.
      processedReviewBodyIds = pendingReviewBodyIds(workerState, repoSlug, mentionItem);
      workerState.close();

      const totalIssueComments = candidateIssueComments.length;
      const alreadyAddressedIssue = totalIssueComments - processedConversationComments.length;

      console.log(`   Found ${totalIssueComments} conversation comment(s) in scope`);
      if (alreadyAddressedIssue > 0) {
        console.log(`   ${alreadyAddressedIssue} already addressed (skipping)`);
      }
      console.log(`   ${processedConversationComments.length} remaining to address`);

      // A commented review is informational by nature: only act on it when a bot
      // identity is explicitly mentioned — in the review body itself or in one of
      // the comments beneath it. changes_requested reviews are always addressed.
      // A mention-triggered run was already gated on the mention by the worker.
      if (
        review?.state === "COMMENTED" &&
        !mentionItem &&
        !commentedReviewMentionsBot(
          [
            review.body,
            ...processedComments.map((c) => c.body),
            ...processedConversationComments.map((c) => c.body),
          ],
          botNames,
          prUrl,
          verbose,
        )
      ) {
        return null;
      }

      // If nothing remains (review comments, conversation comments, or a
      // mentioning review's body), we're done
      if (
        processedComments.length === 0 &&
        processedConversationComments.length === 0 &&
        processedReviewBodyIds.length === 0
      ) {
        console.log("\n✅ All review and conversation comments have been addressed already.");
        console.log(`   View PR: ${prUrl}`);
        return null;
      }

      return buildFeedbackSelection({
        pr,
        prNumber,
        repoSlug,
        review,
        mentionItem,
        comments: processedComments,
        conversationComments: processedConversationComments,
      });
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
        processedReviewBodyIds,
      );
    },
  };
}
