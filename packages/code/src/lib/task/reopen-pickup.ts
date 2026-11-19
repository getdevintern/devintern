/**
 * Session-pickup option for re-queued ad-hoc tasks: reopen a `succeeded` prior
 * run whose branch has no PR or an open one.
 */

import { PRManager } from "../code-host/manager";
import { INJECTED_CREATED_AT_ENV, parseInjectedCreatedAt } from "../state/session-pickup";
import type { ChangeRequestState, SessionPickupOptions } from "../state/session-pickup";

/**
 * State of the code host's PR(s) for `branch`.
 *
 * `"none"` (the branch has no PR) is kept apart from unknown so the caller can
 * tell a branch pushed without a PR from one whose state could not be checked.
 * A failed lookup (expired token, rate limit, network error) or an unsupported
 * code host reads as unknown.
 *
 * @param branch - Head/feature branch name
 * @param lookup - PR state lookup (defaults to {@link PRManager.getChangeRequestState})
 * @returns `"open"`, `"closed"` (closed or merged), `"none"`, or `undefined`
 *   when the state cannot be confirmed
 */
export async function isChangeRequestOpen(
  branch: string,
  lookup: (branch: string) => Promise<ChangeRequestState | undefined> = (b) =>
    new PRManager().getChangeRequestState(b),
): Promise<ChangeRequestState | undefined> {
  try {
    return await lookup(branch);
  } catch {
    return undefined;
  }
}

/**
 * Session-pickup option that lets a re-queued ad-hoc task continue a
 * `succeeded` prior run whose branch has no PR or an open one.
 *
 * Only ad-hoc (`origin: "local"`) runs qualify: tracker tasks keep a succeeded
 * run final. Without git delivery there is no branch to check out, so the
 * option is omitted too. It is also omitted without the injected row's enqueue
 * time ({@link INJECTED_CREATED_AT_ENV}); with it, only runs of that same row
 * (so only a re-queue) can be reopened, never a run left by an earlier task
 * that reused the `local-<slug>` key.
 *
 * @param input.origin - Origin of the run being picked up for
 * @param input.gitEnabled - Whether the feature branch will be checked out
 * @param input.env - Environment carrying the injected row's enqueue time
 * @param input.lookup - PR state lookup override (tests)
 */
export function reopenSucceededPickupOption(input: {
  origin?: string;
  gitEnabled: boolean;
  env?: NodeJS.ProcessEnv;
  lookup?: Parameters<typeof isChangeRequestOpen>[1];
}): Pick<SessionPickupOptions, "reopenSucceeded"> {
  if (input.origin !== "local" || !input.gitEnabled) return {};
  const notBefore = parseInjectedCreatedAt((input.env ?? process.env)[INJECTED_CREATED_AT_ENV]);
  if (notBefore === undefined) return {};
  return {
    reopenSucceeded: {
      notBefore,
      isChangeRequestOpen: ({ branch }) => isChangeRequestOpen(branch, input.lookup),
    },
  };
}
