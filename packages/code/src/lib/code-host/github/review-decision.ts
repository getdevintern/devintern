/**
 * Read a pull request's `reviewDecision` (GraphQL; REST has no equivalent).
 */

import { Utils } from "../../utils";
import { apiErrorMessage } from "./github-errors";
import type { GitHubReviewsClient } from "./reviews";

const REVIEW_DECISION_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } }
}`;

interface ReviewDecisionResponse {
  data?: {
    repository?: { pullRequest?: { reviewDecision?: string | null } | null } | null;
  } | null;
  errors?: Array<{ message: string }>;
}

/**
 * GitHub's `reviewDecision` for a pull request: `APPROVED`,
 * `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or `null` when the base branch
 * requires no review. It states what the branch's rules require, whether or
 * not this credential could bypass them. Throws when GitHub refuses or omits
 * the field, so a caller never reads that as `null`.
 */
export async function pullRequestReviewDecision(
  client: Pick<GitHubReviewsClient, "getToken">,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string | null> {
  const token = await client.getToken(owner, repo);
  const http = await Utils.fetchWithRetry("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "devintern",
    },
    body: JSON.stringify({
      query: REVIEW_DECISION_QUERY,
      variables: { owner, repo, number: prNumber },
    }),
  });
  if (!http.ok) throw new Error(apiErrorMessage(http.status, http.statusText));
  const response = (await http.json()) as ReviewDecisionResponse;
  if (response.errors?.length) {
    const detail = response.errors.map((error) => error.message).join("; ");
    throw new Error(`GitHub refused the review decision for #${prNumber}: ${detail}`);
  }
  const pullRequest = response.data?.repository?.pullRequest;
  if (!pullRequest || !("reviewDecision" in pullRequest)) {
    throw new Error(`GitHub returned no review decision for #${prNumber}`);
  }
  return pullRequest.reviewDecision ?? null;
}
