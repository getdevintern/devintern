/**
 * Read-only workspace automation catalog for a standalone dashboard
 *
 * `devintern dashboard` runs without the worker, so it has no in-process
 * scheduler. It still lists the workspace's `[[automations]]` (the explicit
 * `--workspace`, else the default workspace when one exists).
 *
 * This lists the workspace's automations (with the durable next-due cursor the
 * worker keeps in the workspace DB) but refuses "Run now": workspace runs go
 * through the fleet pipeline (routing, base worktrees, per-repo locks) that only
 * exists in the worker process.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

import type {
  AutomationScheduleStatus,
  DashboardAutomationActions,
  ManualTriggerOutcome,
} from "./acquirer";
import { loadWorkspaceConfig } from "../workspace/config";
import { workspaceConfigPath, workspaceDbPath } from "../workspace/paths";
import { pickAgentSelection } from "../agent/selection";
import { ESTIMATION_JOB_PREFIX } from "./scheduled-jobs";

/** Reason shown when "Run now" is pressed on a standalone workspace dashboard. */
export const WORKSPACE_MANUAL_RUN_UNAVAILABLE =
  "Run now needs the worker: start `devintern worker` for this workspace and use its dashboard.";

/**
 * Durable next-due timestamps keyed by automation id, read without creating or
 * migrating the DB. Missing file or table yields an empty map.
 */
function readNextDue(dbPath: string): Map<string, number> {
  const due = new Map<string, number>();
  if (!existsSync(dbPath)) return due;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT automation_id, next_due_at FROM automation_schedules").all() as {
      automation_id: unknown;
      next_due_at: unknown;
    }[];
    for (const row of rows) {
      if (typeof row.automation_id === "string" && typeof row.next_due_at === "number") {
        due.set(row.automation_id, row.next_due_at);
      }
    }
  } catch {
    // No schedule table yet (worker never ran) or a locked/corrupt DB: list
    // the automations without next-due times rather than failing the page.
  } finally {
    db?.close();
  }
  return due;
}

/**
 * Build list-only dashboard actions over a workspace's `[[automations]]`.
 *
 * @param workspaceDir - Workspace home holding `workspace.toml` and its DB
 */
export function loadWorkspaceAutomationActions(workspaceDir: string): DashboardAutomationActions {
  const list = (): AutomationScheduleStatus[] => {
    let automations;
    let estimations;
    try {
      ({ automations, estimations } = loadWorkspaceConfig(workspaceConfigPath(workspaceDir)));
    } catch {
      // An invalid workspace.toml must not take the dashboard down; the
      // Workspace page reports the problems.
      return [];
    }
    const nextDue = readNextDue(workspaceDbPath(workspaceDir));
    const jobs: AutomationScheduleStatus[] = automations.map((automation) => ({
      id: automation.id,
      kind: "automation" as const,
      enabled: automation.enabled,
      cron: automation.cron,
      interval: automation.interval,
      repo: automation.repo,
      prompt: automation.prompt,
      openPr: automation.openPr === true,
      ...pickAgentSelection(automation),
      nextDueAt: nextDue.get(automation.id),
    }));
    // Estimation sweeps share the scheduler table under a namespaced state id.
    for (const estimation of estimations) {
      jobs.push({
        id: `${ESTIMATION_JOB_PREFIX}${estimation.id}`,
        title: estimation.id,
        kind: "estimation",
        enabled: estimation.enabled,
        cron: estimation.cron,
        interval: estimation.interval,
        prompt: "",
        openPr: false,
        query: estimation.query,
        team: estimation.team,
        ...pickAgentSelection(estimation),
        nextDueAt: nextDue.get(`${ESTIMATION_JOB_PREFIX}${estimation.id}`),
        runFilter: { automationId: estimation.id, origin: "estimate" },
      });
    }
    return jobs;
  };

  const trigger = async (): Promise<ManualTriggerOutcome> => ({
    ok: false,
    reason: WORKSPACE_MANUAL_RUN_UNAVAILABLE,
  });

  return { list, trigger };
}
