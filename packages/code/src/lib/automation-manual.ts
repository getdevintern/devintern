/**
 * Standalone-dashboard automation actions
 *
 * `devintern dashboard` runs without the worker daemon, so there is no
 * scheduler in-process to drive a manual run. Automations configured in the
 * project's `.devintern-code/automations.toml` can still be triggered by
 * hand: the dashboard materializes the prompt as an occurrence task file and
 * spawns the regular CLI pipeline — the documented manual flow
 * (`devintern ~/.devintern/automations/<id>/<stamp>.md`) — with the `manual`
 * origin marker so run history distinguishes it from scheduled runs.
 *
 * Workspace `[[automations]]` entries are intentionally not served here:
 * they run through the fleet pipeline (routing, base worktrees, per-repo
 * locks) which only exists in the worker process, so triggering them belongs
 * to the worker's embedded dashboard.
 */

import { automationDisplayPrompt, loadSingleRepoAutomations } from "./automation-config";
import type { AutomationConfig } from "./automation-config";
import {
  AUTOMATION_ID_ENV,
  MANUAL_ORIGIN_ENV_VALUE,
  spawnManualAutomationRun,
} from "./automation-acquirer";
import type {
  AutomationRunContext,
  AutomationScheduleStatus,
  DashboardAutomationActions,
  ManualTriggerOutcome,
  SpawnedAutomationRun,
} from "./automation-acquirer";
import { RUN_ORIGIN_ENV } from "./analytics";
import { workerTaskArgs } from "./task-polling-acquirer";

/** Test-only spawn override so manual-run tests never launch a real CLI. */
export interface StandaloneAutomationOptions {
  spawnRun?: (automation: AutomationConfig, context: AutomationRunContext) => SpawnedAutomationRun;
}

/** Build the dashboard actions backed by the project's own automation config. */
export function loadStandaloneAutomationActions(
  workingDir: string,
  options: StandaloneAutomationOptions = {},
): DashboardAutomationActions {
  const list = (): AutomationScheduleStatus[] => {
    try {
      return loadSingleRepoAutomations(workingDir).map((automation) => ({
        id: automation.id,
        enabled: automation.enabled,
        cron: automation.cron,
        interval: automation.interval,
        repo: automation.repo,
        prompt: automationDisplayPrompt(automation),
      }));
    } catch {
      // A malformed automations.toml must not take the dashboard down; the
      // worker surfaces config errors at startup.
      return [];
    }
  };

  const trigger = async (automationId: string): Promise<ManualTriggerOutcome> => {
    let automation;
    try {
      automation = loadSingleRepoAutomations(workingDir).find((item) => item.id === automationId);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    if (!automation) {
      return { ok: false, reason: `automation "${automationId}" is not configured` };
    }
    if (!automation.enabled) {
      return {
        ok: false,
        reason: `automation "${automationId}" is disabled; enable it in the config first`,
      };
    }
    const context: AutomationRunContext = {
      cwd: workingDir,
      // Attribution lives on the context so any spawn path (and the run
      // records the CLI writes) sees the manual origin.
      env: {
        ...process.env,
        [RUN_ORIGIN_ENV]: MANUAL_ORIGIN_ENV_VALUE,
        [AUTOMATION_ID_ENV]: automation.id,
      },
      release() {},
    };
    const run = options.spawnRun
      ? options.spawnRun(automation, context)
      : spawnManualAutomationRun(automation, context, workerTaskArgs());
    void run.completion.then((ok) => {
      console.log(
        ok
          ? `✅ [automation:${automation.id}] manual run completed`
          : `⚠️  [automation:${automation.id}] manual run did not complete cleanly`,
      );
    });
    return { ok: true };
  };

  return { list, trigger };
}
