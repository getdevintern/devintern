import type { ChangeRequestIdentity } from "./code-host";
import type { ReviewAdapter } from "./review-provider";
import { WorkerState } from "./worker-state";
import type {
  ProcessedReviewComment,
  ProcessedReviewFeedback,
  ProcessedConversationComment,
} from "../types/github-webhooks";
import { GitLabReviewsClient } from "./gitlab-reviews";
import { resolveGitLabCodeHostConfig } from "./code-host";
import { extractAgentSummary } from "./review-formatter";

export async function createGitLabReviewAdapter(
  identity: ChangeRequestIdentity,
): Promise<ReviewAdapter> {
  const config = resolveGitLabCodeHostConfig(identity.instanceUrl);
  if (!config.ok) throw new Error(config.message);
  const gitlabClient = new GitLabReviewsClient(config.token, config.instanceUrl, {
    caFile: config.caFile,
    proxy: config.proxy,
  });
  const prNumber = identity.number;
  const prUrl = identity.webUrl;
  console.log("\n📋 Fetching MR details...");
  const gitlabContext = await gitlabClient.getReviewContext(identity.projectPath, prNumber);
  const pr = {
    title: gitlabContext.mergeRequest.title,
    state: gitlabContext.mergeRequest.state,
    head: { ref: gitlabContext.mergeRequest.source_branch, sha: gitlabContext.mergeRequest.sha },
  };
  let processedComments: ProcessedReviewComment[] = [];
  let processedConversationComments: ProcessedConversationComment[] = [];
  let gitlabDiscussionIds: string[] = [];
  return {
    change: pr,
    async loadFeedback() {
      const stateKey = `gitlab:${identity.instanceUrl}:${gitlabContext.projectPath}`;
      const workerState = new WorkerState();
      try {
        processedComments = gitlabContext.feedback.comments.filter(
          (comment) => !workerState.isCommentAddressed(stateKey, "review", comment.id),
        );
        processedConversationComments = (gitlabContext.feedback.conversationComments ?? []).filter(
          (comment) => !workerState.isCommentAddressed(stateKey, "conversation", comment.id),
        );
      } finally {
        workerState.close();
      }

      const remainingIds = new Set([
        ...processedComments.map((comment) => comment.id),
        ...processedConversationComments.map((comment) => comment.id),
      ]);
      gitlabDiscussionIds = [
        ...new Set(
          [...remainingIds]
            .map((noteId) => gitlabContext?.discussionByNoteId[noteId])
            .filter((discussionId): discussionId is string => Boolean(discussionId)),
        ),
      ];

      console.log(`\n📥 Found ${gitlabContext.noteIds.length} human feedback note(s)`);
      const alreadyAddressed = gitlabContext.noteIds.length - remainingIds.size;
      if (alreadyAddressed > 0) {
        console.log(`   ${alreadyAddressed} already addressed (skipping)`);
      }
      console.log(`   ${remainingIds.size} remaining to address`);
      if (remainingIds.size === 0) {
        console.log("\n✅ All unresolved GitLab feedback has been addressed already.");
        console.log(`   View MR: ${prUrl}`);
        return null;
      }

      const feedback: ProcessedReviewFeedback = {
        ...gitlabContext.feedback,
        comments: processedComments,
        conversationComments:
          processedConversationComments.length > 0 ? processedConversationComments : undefined,
      };

      return {
        feedback,
        stageSummary: `addressing ${remainingIds.size} GitLab feedback note(s) from ${feedback.reviewer}`,
        stageDetail: {
          provider: "gitlab",
          reviewers: feedback.reviewer,
          reviewComments: processedComments.length,
          conversationComments: processedConversationComments.length,
        },
      };
    },
    async beforePush() {
      console.log("\n🔒 Revalidating GitLab MR head before push...");
      await gitlabClient.assertHeadSha(
        gitlabContext.projectId,
        prNumber,
        gitlabContext.mergeRequest.sha,
      );
    },
    async acknowledge(output) {
      console.log("\n💬 Replying to GitLab discussions...");
      const summary = extractAgentSummary(output);
      const replies = await gitlabClient.replyToDiscussions(
        gitlabContext.projectId,
        prNumber,
        gitlabDiscussionIds,
        `✅ Addressed this feedback in the latest commit.\n\n${summary}`,
      );
      const stateKey = `gitlab:${identity.instanceUrl}:${gitlabContext.projectPath}`;
      const workerState = new WorkerState();
      try {
        workerState.markCommentsAddressed(
          stateKey,
          "review",
          processedComments.map((comment) => comment.id),
        );
        workerState.markCommentsAddressed(
          stateKey,
          "conversation",
          processedConversationComments.map((comment) => comment.id),
        );
      } finally {
        workerState.close();
      }
      console.log(`   Replied to ${replies.replied} discussion(s); left them unresolved.`);
      if (replies.failures.length > 0) {
        console.warn(
          `   ⚠️  Could not reply to ${replies.failures.length} discussion(s): ${replies.failures.join("; ")}`,
        );
      }
    },
  };
}
