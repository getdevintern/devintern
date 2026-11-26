/**
 * Worker operating-policy prompts for `devintern worker init`: CI repair,
 * conflict handling, active hours, and the one-question recommended
 * settings that replace them on a first setup.
 */

import { parseCronOrIntervalSchedule } from "../automation/config";
import { isValidTimeZone, parseTimeWindowSpec } from "../worker/schedule";
import { writeWorkerOperatingPolicy } from "../workspace/init";
import type { WorkerOperatingPolicy } from "../workspace/init";
import { loadWorkspaceConfig } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import { workspaceConfigPath } from "../workspace/paths";

export type PromptFn = (question: string) => Promise<string>;
export type LogFn = (message: string) => void;

/**
 * Ask a yes/no question until the answer is y/yes, n/no, or empty (the
 * default). Anything else re-asks instead of being read as either answer.
 */
export async function askYesNo(
  ctx: { prompt: PromptFn; log: LogFn },
  question: string,
  fallback: boolean,
): Promise<boolean> {
  for (;;) {
    const answer = (await ctx.prompt(question)).trim().toLowerCase();
    if (!answer) return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    ctx.log("   Enter y or n.");
  }
}

/** Prompt for the conflict-resolution mode and, when scheduled, its cadence. */
async function promptConflictPolicy(
  ctx: { workspaceDir: string; prompt: PromptFn; log: LogFn },
  current: WorkspaceConfig,
): Promise<{
  conflictResolution: WorkspaceConfig["workspace"]["conflictResolution"];
  conflictResolutionCron?: string;
  conflictResolutionInterval?: string;
}> {
  let conflictResolution = current.workspace.conflictResolution;
  for (;;) {
    const answer = (
      await ctx.prompt(
        `Conflict handling [auto/scheduled/disabled] [${current.workspace.conflictResolution}]: `,
      )
    )
      .trim()
      .toLowerCase();
    if (!answer) break;
    if (answer === "auto" || answer === "scheduled" || answer === "disabled") {
      conflictResolution = answer;
      break;
    }
    ctx.log("   Choose auto, scheduled, or disabled.");
  }

  let conflictResolutionCron: string | undefined;
  let conflictResolutionInterval: string | undefined;
  if (conflictResolution === "scheduled") {
    const existingSchedule =
      current.workspace.conflictSchedule?.cron ??
      current.workspace.conflictSchedule?.interval ??
      "0 3 * * *";
    for (;;) {
      const value =
        (
          await ctx.prompt(
            `Conflict-resolution schedule (cron or interval) [${existingSchedule}]: `,
          )
        ).trim() || existingSchedule;
      const errors: string[] = [];
      const isCron = value.split(/\s+/).length > 1;
      const parsed = parseCronOrIntervalSchedule(
        isCron ? { cron: value } : { interval: value },
        { label: "Conflict schedule" },
        errors,
      );
      if (parsed) {
        conflictResolutionCron = parsed.cron;
        conflictResolutionInterval = parsed.interval;
        break;
      }
      ctx.log(`   ${errors.join(" ")}`);
    }
  }

  return { conflictResolution, conflictResolutionCron, conflictResolutionInterval };
}

/** Prompt for active-hours windows and timezone. */
async function promptActiveSchedule(
  ctx: { workspaceDir: string; prompt: PromptFn; log: LogFn },
  currentSchedule: WorkspaceConfig["worker"]["schedule"],
): Promise<{ activeWindows: string[]; blockedWindows: string[]; timezone: string }> {
  const existingWindows =
    currentSchedule?.active.map((window) => window.spec).join(",") || "22:00-06:00";
  let activeWindows: string[] = [];
  for (;;) {
    activeWindows = (
      (await ctx.prompt(`Active windows, comma-separated [${existingWindows}]: `)).trim() ||
      existingWindows
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      activeWindows.forEach(parseTimeWindowSpec);
      break;
    } catch (error) {
      ctx.log(`   ${(error as Error).message}`);
    }
  }

  const blockedWindows = currentSchedule?.blocked.map((window) => window.spec) ?? [];
  const existingTimezone = currentSchedule?.timezone ?? "";
  let timezone = "";
  for (;;) {
    timezone =
      (await ctx.prompt(`Timezone [${existingTimezone || "worker machine local"}]: `)).trim() ||
      existingTimezone;
    if (!timezone || isValidTimeZone(timezone)) break;
    ctx.log(`   "${timezone}" is not a valid IANA timezone.`);
  }

  return { activeWindows, blockedWindows, timezone };
}

/** The worker settings `worker init` recommends for a first setup. */
export const RECOMMENDED_WORKER_POLICY = {
  ciFailureFix: false,
  conflictResolution: "auto",
  activeWindows: [],
  catchUpMissed: true,
} as const satisfies WorkerOperatingPolicy;

/** What the recommended settings mean, for the one-question prompt. */
export const RECOMMENDED_WORKER_SETTINGS_SUMMARY =
  "no CI repair, automatic conflict resolution, pick up tasks 24/7, no Sentry";

/**
 * How the workspace's settings differ from {@link RECOMMENDED_WORKER_POLICY},
 * e.g. `CI repair on, 1 Sentry monitor`; null when they match.
 */
export function describeCustomWorkerSettings(config: WorkspaceConfig): string | null {
  const parts: string[] = [];
  if (config.workspace.ciFailureFix) parts.push("CI repair on");
  if (config.workspace.conflictResolution !== "auto") {
    parts.push(`conflict resolution ${config.workspace.conflictResolution}`);
  }
  const schedule = config.worker.schedule;
  if (schedule) {
    const windows = schedule.active.map((window) => window.spec).join(",");
    parts.push(windows ? `active hours ${windows}` : "active hours limited");
  }
  const monitors = config.errorMonitors.length;
  if (monitors > 0) parts.push(monitors === 1 ? "1 Sentry monitor" : `${monitors} Sentry monitors`);
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function configureWorkerOperatingPolicy(ctx: {
  workspaceDir: string;
  prompt: PromptFn;
  log: LogFn;
}): Promise<void> {
  const current = loadWorkspaceConfig(workspaceConfigPath(ctx.workspaceDir));
  const yesNo = (question: string, fallback: boolean) => askYesNo(ctx, question, fallback);

  const ciFailureFix = await yesNo(
    `Automatically repair failing CI on worker-created PRs? [${current.workspace.ciFailureFix ? "Y/n" : "y/N"}]: `,
    current.workspace.ciFailureFix,
  );

  const { conflictResolution, conflictResolutionCron, conflictResolutionInterval } =
    await promptConflictPolicy(ctx, current);

  const currentSchedule = current.worker.schedule;
  const limitPickup = await yesNo(
    `Limit new-task pickup to active hours? [${currentSchedule ? "Y/n" : "y/N"}]: `,
    currentSchedule !== null,
  );
  let activeWindows: string[] = [];
  let blockedWindows: string[] = [];
  let timezone = "";
  if (limitPickup) {
    ({ activeWindows, blockedWindows, timezone } = await promptActiveSchedule(
      ctx,
      currentSchedule,
    ));
  }

  writeWorkerOperatingPolicy(ctx.workspaceDir, {
    ciFailureFix,
    conflictResolution,
    conflictResolutionCron,
    conflictResolutionInterval,
    activeWindows,
    blockedWindows,
    timezone,
    catchUpMissed: currentSchedule?.catchUpMissed ?? true,
  });
  ctx.log("💾 Wrote worker operating policy to workspace.toml.");
}
