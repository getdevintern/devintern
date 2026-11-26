import type { ChangeRequestIdentity } from "./index";
import type { ReviewAdapter } from "./review-provider";
import { createGitHubReviewAdapter } from "./github/review-adapter";
import type { GitHubReviewAdapterOptions } from "./github/review-adapter";
import { createGitLabReviewAdapter } from "./gitlab/review-adapter";

export function createReviewAdapter(
  identity: ChangeRequestIdentity,
  verbose: boolean,
  options: GitHubReviewAdapterOptions = {},
): Promise<ReviewAdapter> {
  if (identity.provider === "github") return createGitHubReviewAdapter(identity, verbose, options);
  if (identity.provider === "gitlab") return createGitLabReviewAdapter(identity);
  throw new Error("Review addressing is unavailable for Bitbucket");
}
