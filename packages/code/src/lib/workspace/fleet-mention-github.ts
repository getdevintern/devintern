/**
 * GitHub read adapters for the @mention feeds wired in
 * `fleet-event-acquirers.ts`: the mention sweep's reviews feed and the relay
 * mention handlers.
 */
import type { ReviewFeedGitHub } from "../acquirers/mention-sweep";
import type { GitHubReviewsClient } from "../code-host/github/reviews";
import type { RelayMentionGitHub, RelayMentionItem } from "../relay/mention-handlers";

/** One submitted review as the mention feeds read it. */
interface RawReview {
  id: number;
  body: string | null;
  user: { login: string; type?: string } | null;
  submitted_at?: string | null;
  html_url?: string;
}

/** List a PR's submitted reviews (first 100). */
async function listPrReviews(
  client: GitHubReviewsClient,
  slug: string,
  prNumber: number,
): Promise<RawReview[]> {
  const [owner, name] = slug.split("/") as [string, string];
  const result = await client.conditionalGet<RawReview[]>(
    `/repos/${slug}/pulls/${prNumber}/reviews?per_page=100`,
    owner,
    name,
  );
  return result.data ?? [];
}

/** GitHub reads for the mention sweep's reviews feed on one repository. */
export function reviewFeedGitHub(client: GitHubReviewsClient, slug: string): ReviewFeedGitHub {
  const [owner, name] = slug.split("/") as [string, string];
  return {
    listOpenPrsByUpdated: async () =>
      (
        await client.conditionalGet<Array<{ number: number; updated_at: string; url: string }>>(
          `/repos/${slug}/pulls?state=open&sort=updated&direction=desc&per_page=30`,
          owner,
          name,
        )
      ).data ?? [],
    listReviews: (prNumber) => listPrReviews(client, slug, prNumber),
  };
}

/** GitHub reads for the relay mention handlers on one repository. */
export function relayMentionGitHub(client: GitHubReviewsClient, slug: string): RelayMentionGitHub {
  const [owner, name] = slug.split("/") as [string, string];
  return {
    getIssueComment: async (commentId) => {
      try {
        const result = await client.conditionalGet<RelayMentionItem>(
          `/repos/${slug}/issues/comments/${commentId}`,
          owner,
          name,
        );
        return result.data;
      } catch (error) {
        const { isGitHubNotFound } = await import("../code-host/github/github-errors");
        if (isGitHubNotFound(error)) return null;
        throw error;
      }
    },
    listReviews: (prNumber) => listPrReviews(client, slug, prNumber),
    listReviewComments: async (prNumber, reviewId) =>
      (
        await client.conditionalGet<RelayMentionItem[]>(
          `/repos/${slug}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`,
          owner,
          name,
        )
      ).data ?? [],
    getBotUsername: () => client.getBotUsername(owner, name),
  };
}
