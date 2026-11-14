/** The fields grouping reads; both the run catalog and workspace views carry them. */
export interface GroupableAutomation {
  id: string;
  enabled: boolean;
  repo?: string;
  nextDueAt?: number;
}

/** Automations sharing one target: a workspace repo, or none (general). */
export interface AutomationGroup<T extends GroupableAutomation = GroupableAutomation> {
  /** Stable key: `general`, or `repo:<name>`. */
  key: string;
  /** Target repository; undefined for the general group. */
  repo?: string;
  automations: T[];
}

/** Enabled before disabled, then soonest next run; unscheduled last. */
function compareAutomations(a: GroupableAutomation, b: GroupableAutomation): number {
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
export function groupAutomationsByRepo<T extends GroupableAutomation>(
  automations: T[],
): AutomationGroup<T>[] {
  const general: T[] = [];
  const byRepo = new Map<string, T[]>();
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
  const groups: AutomationGroup<T>[] = [];
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

/**
 * Whether a table should show group header rows: whenever any automation
 * names a repo. Only an all-general list stays flat, since a lone "General"
 * heading would just repeat the section title.
 */
export function showsGroupHeaders(groups: AutomationGroup[]): boolean {
  return groups.some((group) => group.repo !== undefined);
}
