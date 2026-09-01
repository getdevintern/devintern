import {
  AUTOMATION_ID_ENV,
  AUTOMATION_ORIGIN_ENV,
  AutomationAcquirer,
  spawnAutomationProcess,
} from "./automation-acquirer";
import type { AutomationRunContext, SpawnedAutomationRun } from "./automation-acquirer";
import type { AutomationConfig } from "./automation-config";
import type { EstimationConfig } from "./estimation-config";

/** Value of the run-origin marker that attributes CLI runs to scheduled estimation. */
export const ESTIMATION_ORIGIN_ENV_VALUE = "estimate";
/** Durable-schedule namespace so estimations never collide with automation ids. */
const STATE_PREFIX = "estimation:";

export interface EstimationAcquirerOptions {
  estimations: EstimationConfig[];
  dbPath: string;
  /**
   * Resolve where/how one due sweep runs. Unlike automations this never
   * clones a repository or takes a repo lock; returning null still means
   * "skip this occurrence".
   */
  resolveContext: (estimation: EstimationConfig) => Promise<AutomationRunContext | null>;
  /** Test-only runner override; defaults to spawning the CLI estimate sweep. */
  spawnRun?: (estimation: EstimationConfig, context: AutomationRunContext) => SpawnedAutomationRun;
  /** Remaining fields are test-only scheduler/process overrides. */
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

/** CLI arguments for one due estimation sweep (`--estimate` stays the engine). */
export function estimationCliArgs(estimation: EstimationConfig): string[] {
  return ["--estimate", "--query", estimation.query, "--no-git"];
}

/**
 * Attribution env for the sweep subprocess: a distinct run origin (never an
 * implement "scheduled" run) plus the owning schedule id.
 */
export function estimationRunEnv(
  estimation: EstimationConfig,
  base?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...base,
    [AUTOMATION_ORIGIN_ENV]: ESTIMATION_ORIGIN_ENV_VALUE,
    [AUTOMATION_ID_ENV]: estimation.id,
  };
}

/**
 * Run one due sweep as the regular one-shot `devintern --estimate --query`
 * pipeline in the workspace home. That path already implements the skip
 * gates (<24h old / unchanged since last estimate), writes points + updates
 * the estimate comment in place, treats usage-limit aborts as exit 0, and
 * never creates branches, worktrees, or PRs.
 */
export function spawnEstimationSweep(
  estimation: EstimationConfig,
  context: AutomationRunContext,
  terminationGraceMs?: number,
): SpawnedAutomationRun {
  return spawnAutomationProcess(
    process.execPath,
    [process.argv[1] as string, ...estimationCliArgs(estimation)],
    {
      cwd: context.cwd,
      env: estimationRunEnv(estimation, context.env),
      terminationGraceMs,
    },
  );
}

/**
 * Scheduled story-point sweeps driven by the automation **scheduler**
 * (durable cursors, leases, overlap coalescing) — never its prompt pipeline.
 */
export class EstimationAcquirer extends AutomationAcquirer {
  constructor(options: EstimationAcquirerOptions) {
    const schedules = estimationSchedules(options.estimations);
    super({
      automations: schedules,
      dbPath: options.dbPath,
      name: "scheduled-estimations",
      jobKind: "estimation",
      stateId: (schedule) => `${STATE_PREFIX}${schedule.id}`,
      resolveContext: (schedule) => options.resolveContext(schedule as ScheduledEstimation),
      spawnRun: (schedule, context) => {
        const estimation = schedule as ScheduledEstimation;
        return options.spawnRun
          ? options.spawnRun(estimation, context)
          : spawnEstimationSweep(estimation, context);
      },
      now: options.now,
      leaseMs: options.leaseMs,
      heartbeatMs: options.heartbeatMs,
      terminationGraceMs: options.terminationGraceMs,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      setInterval: options.setInterval,
      clearInterval: options.clearInterval,
    });
  }

  /** Reconcile scheduled estimation entries after a live workspace reload. */
  applyEstimations(estimations: EstimationConfig[]): void {
    this.applyAutomations(estimationSchedules(estimations));
  }
}

type ScheduledEstimation = AutomationConfig & EstimationConfig;

/** Adapt estimation bodies to the shared durable scheduler's config shape. */
function estimationSchedules(estimations: EstimationConfig[]): ScheduledEstimation[] {
  return estimations.map((item) => ({ ...item, prompt: "" }));
}
