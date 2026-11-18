/**
 * Turn a tracker ticket's native blockers into {@link DependencyFacts} for
 * the provider-neutral gate.
 *
 * A blocker this worker implemented (it has a run or a queue row here) is
 * judged by its local facts, exactly like an ad-hoc dependency: merged mode
 * waits for its PR to merge, stacked mode stacks on its open PR. A blocker the
 * worker never handled is satisfied only once the tracker reports it done.
 *
 * The tracker also gets the last word on a locally blocked blocker: once a
 * person resolves it as done (finished it by hand, or decided it no longer
 * blocks), the dependent stops being blocked by the worker's failed attempt.
 */

import type { TaskBlocker } from "../trackers/client";
import type { DependencyFacts } from "./gate";
import { classifyDependency } from "./gate";

/** Whether the worker has handled this dependency itself. */
function handledLocally(facts: DependencyFacts | undefined): facts is DependencyFacts {
  return facts !== undefined && (facts.latestRun !== undefined || facts.work !== "missing");
}

/**
 * Build gate facts for a ticket's blockers.
 *
 * @param blockers - Blockers as the tracker reports them
 * @param local - Local facts for the same keys (any order; see `readLocalDependencyFacts`)
 */
export function trackerBlockerFacts(
  blockers: readonly TaskBlocker[],
  local: readonly DependencyFacts[],
): DependencyFacts[] {
  const byKey = new Map(local.map((facts) => [facts.key, facts]));
  return blockers.map((blocker) => {
    const facts = byKey.get(blocker.key);
    if (handledLocally(facts)) {
      if (blocker.done === true && classifyDependency(facts).state === "blocked") {
        return { key: blocker.key, work: "done" };
      }
      return facts;
    }
    return blocker.done === true
      ? { key: blocker.key, work: "done" }
      : { key: blocker.key, work: "open", trackerStatus: blocker.status };
  });
}
