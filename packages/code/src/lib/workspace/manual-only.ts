/**
 * `manual_only` repos: registered for manual CLI runs from a local checkout,
 * never run by the worker.
 */

import type { AutomationConfig } from "../automation/config";
import type {
  ErrorMonitorConfig,
  RepoConfig,
  RoutingRule,
  TeamConfig,
  WorkspaceConfig,
} from "./config-types";

/**
 * Report worker work aimed at a `manual_only` repo: teams, error monitors,
 * routing rules, and automations the worker would run there.
 */
export function validateManualOnlyReferences(
  repos: RepoConfig[],
  refs: {
    teams: TeamConfig[];
    errorMonitors: ErrorMonitorConfig[];
    routing: RoutingRule[];
    automations: AutomationConfig[];
  },
  errors: string[],
): void {
  const manual = new Set(repos.filter((repo) => repo.manualOnly).map((repo) => repo.name));
  if (manual.size === 0) return;
  const check = (label: string, repo: string | undefined): void => {
    if (repo && manual.has(repo)) {
      errors.push(
        `${label} targets "${repo}", which is manual_only; the worker does not run work there.`,
      );
    }
  };
  for (const team of refs.teams) check(`[[teams]] "${team.name}".repo`, team.repo);
  for (const monitor of refs.errorMonitors)
    check(`[[error_monitors]] "${monitor.id}"`, monitor.repo);
  for (const [index, rule] of refs.routing.entries())
    check(`[routing] rule ${index + 1}`, rule.repo);
  for (const automation of refs.automations)
    check(`[[automations]] "${automation.id}"`, automation.repo);
}

/**
 * The worker's view of a workspace: `manual_only` repos removed, so nothing
 * in the fleet path clones, polls, or schedules them.
 */
export function workerWorkspaceView(config: WorkspaceConfig): WorkspaceConfig {
  if (!config.repos.some((repo) => repo.manualOnly)) return config;
  return { ...config, repos: config.repos.filter((repo) => !repo.manualOnly) };
}
