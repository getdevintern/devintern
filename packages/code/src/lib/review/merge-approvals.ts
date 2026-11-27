/**
 * Review-state gates of auto-merge (gate 0): reviewers' change requests and,
 * for teammates' PRs, the base branch's required approvals.
 */

/** Reviewers whose most recent decisive review requests changes. */
export function outstandingChangeRequests(
  reviews: ReadonlyArray<{ state: string; user: { login: string } | null }>,
): string[] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    // Comments do not change a reviewer's decision; dismissals clear it.
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(login, review.state);
  }
  return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login);
}

/**
 * With `requireApproval` (set for teammates' PRs): why the base branch's
 * required reviews are not met, or `null`. The merge call itself can bypass
 * required reviews when the credential is an admin and branch protection does
 * not enforce its rules for admins, so GitHub's `reviewDecision` is checked
 * here instead of relying on GitHub to refuse the merge. Read fresh on each
 * call, so an approval dismissed during the review is seen at the pre-merge
 * re-check. An unreadable decision throws (the check fails and is retried).
 */
export async function approvalFailure(
  policy: { requireApproval?: boolean },
  github: { getReviewDecision(): Promise<string | null> },
): Promise<{ outcome: "waiting"; message: string; approvalWait: true } | null> {
  if (!policy.requireApproval) return null;
  const decision = await github.getReviewDecision();
  if (decision === null || decision === "APPROVED") return null;
  return {
    outcome: "waiting",
    approvalWait: true,
    message:
      decision === "CHANGES_REQUESTED"
        ? "a reviewer requested changes (GitHub review decision)"
        : "branch protection requires an approving review",
  };
}
