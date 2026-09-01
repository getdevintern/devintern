import type { RunRecord } from "@/lib/api";

/**
 * Web URL of the PR a run references, when one exists.
 *
 * PR-mention and conflict-resolution runs record the affected PR (number and
 * URL) at run start; task-pipeline runs attach theirs only after GitHub
 * actually creates the PR, so a run without a PR reference has none to show
 * yet — nothing is fabricated for in-progress runs. Legacy rows recorded
 * before `pr_url` was captured are still linked by deriving the URL from the
 * repo slug and PR number (the same pattern the dashboard API uses for agent
 * PRs).
 */
export function runPrHref(run: Pick<RunRecord, "prUrl" | "prNumber" | "repo">): string | undefined {
  if (run.prUrl) return run.prUrl;
  if (run.prNumber !== undefined && run.repo) {
    return `https://github.com/${run.repo}/pull/${run.prNumber}`;
  }
  return undefined;
}

/**
 * The runs-list "Work" label and link target for a run.
 *
 * Scheduled and manual automation runs materialize their prompt as a local
 * markdown occurrence whose timestamp filename stem becomes the task key, so
 * the automation id is the meaningful identifier and wins for those origins.
 * Estimate sweeps keep the tracker task key they estimated, PR-affected runs
 * (pr mention, conflict resolution) name the PR they operate on, and plain
 * task runs keep their tracker key with its ticket link.
 */
export function runWorkLink(
  run: Pick<
    RunRecord,
    "id" | "origin" | "automationId" | "taskKey" | "ticketUrl" | "prNumber" | "prUrl" | "repo"
  >,
): { label: string; href?: string } {
  if (run.automationId && run.origin !== "estimate") {
    return { label: run.automationId };
  }
  if (run.taskKey) {
    return { label: run.taskKey, href: run.ticketUrl };
  }
  if (run.prNumber !== undefined) {
    return { label: `PR #${run.prNumber}`, href: runPrHref(run) };
  }
  if (run.automationId) {
    return { label: run.automationId };
  }
  return { label: `Run ${run.id}` };
}
