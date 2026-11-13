import type { AutomationSchedule } from "@/lib/api";

/** Automations sharing one target: a workspace repo, or none (general). */
export interface AutomationGroup {
  /** Stable key: `general`, or `repo:<name>`. */
  key: string;
  /** Target repository; undefined for the general group. */
  repo?: string;
  automations: AutomationSchedule[];
}

/** Enabled before disabled, then soonest next run; unscheduled last. */
function compareAutomations(a: AutomationSchedule, b: AutomationSchedule): number {
  return (
    (a.enabled ? 0 : 1) - (b.enabled ? 0 : 1) ||
    (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Group automations by target repository. General automations (no `repo`)
 * come first, then one group per repo sorted by name. Rows within a group
 * are sorted enabled first, then by next due time. Empty groups are omitted.
 */
export function groupAutomationsByRepo(automations: AutomationSchedule[]): AutomationGroup[] {
  const general: AutomationSchedule[] = [];
  const byRepo = new Map<string, AutomationSchedule[]>();
  for (const automation of automations) {
    const repo = automation.repo?.trim();
    if (!repo) {
      general.push(automation);
      continue;
    }
    const list = byRepo.get(repo);
    if (list) list.push(automation);
    else byRepo.set(repo, [automation]);
  }
  const groups: AutomationGroup[] = [];
  if (general.length > 0) {
    groups.push({ key: "general", automations: general.sort(compareAutomations) });
  }
  const repos = [...byRepo.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
  for (const repo of repos) {
    groups.push({
      key: `repo:${repo}`,
      repo,
      automations: (byRepo.get(repo) ?? []).sort(compareAutomations),
    });
  }
  return groups;
}
