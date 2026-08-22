/**
 * Process-wide worker-budget singleton.
 *
 * Ties {@link BudgetGate} into the shared execution/admission boundary:
 *
 * - `devintern worker` calls {@link initWorkerBudget} once at startup. It
 *   parses/validates the cap environment (invalid values abort startup),
 *   marks the process tree as unattended (the marker is inherited by the
 *   task subprocesses the worker spawns), logs the per-run-cap limitation,
 *   and subscribes to run completions for post-run per-run enforcement.
 * - Every admission point (polling acquirers, relay, webhook/review,
 *   mention, workspace dispatch, and the task pipeline itself) funnels
 *   through {@link checkWorkerAdmission}. Manual CLI runs never initialize
 *   the gate and are therefore unaffected.
 *
 * The capped-state notification fires once per entering the capped state
 * (tracked per UTC day in memory); subsequent admissions stay silent while
 * still blocked.
 */

import {
  BudgetGate,
  PER_DAY_CAP_ENV,
  PER_RUN_CAP_ENV,
  WORKER_PROCESS_ENV,
  hasAnyCap,
  parseSpendCapConfig,
} from "./budget-guard";
import type { AdmissionDecision, SpendCapConfig } from "./budget-guard";
import { onRunFinished, RunStore } from "./run-recorder";
import { resolveQueueDbPath } from "./webhook-queue";

let activeGate: BudgetGate | null = null;
let activeConfig: SpendCapConfig | null = null;
/** DB path override for the gate's store (tests); production resolves lazily. */
let configuredDbPath: string | undefined;
/** Day key (UTC ISO date) of the last capped-state notification emitted. */
let lastCappedNoticeDay: string | null = null;

/** Whether this process belongs to an unattended worker tree. */
export function isWorkerProcess(): boolean {
  return process.env[WORKER_PROCESS_ENV] === "1";
}

/**
 * Bind the gate's store lazily: workspace mode sets `WEBHOOK_QUEUE_DB` after
 * worker startup, so the path must not be resolved at init time.
 */
function ensureGate(): BudgetGate | null {
  if (!activeConfig || !hasAnyCap(activeConfig)) {
    return null;
  }
  if (!activeGate) {
    activeGate = new BudgetGate(
      new RunStore(configuredDbPath ?? resolveQueueDbPath()),
      activeConfig,
    );
  }
  return activeGate;
}

/**
 * Initialize budget enforcement for a worker daemon.
 *
 * Validates the cap environment (invalid values throw
 * {@link SpendCapConfigError} so callers can fail startup with an actionable
 * message), marks the process tree as unattended, logs the per-run-cap
 * limitation, and subscribes to run completions for post-run per-run
 * enforcement. The spend store binds lazily on first admission so env-based
 * database overrides (workspace mode) win.
 */
export function initWorkerBudget(
  options: { dbPath?: string; env?: Record<string, string | undefined> } = {},
): void {
  const config = parseSpendCapConfig(options.env ?? process.env);
  activeConfig = config;
  configuredDbPath = options.dbPath;
  lastCappedNoticeDay = null;

  // Mark the process tree unattended regardless of whether caps are set: the
  // flag distinguishes worker-originated runs in the database so budget
  // accounting stays reliable if caps are added later.
  process.env[WORKER_PROCESS_ENV] = "1";

  if (!hasAnyCap(config)) {
    return;
  }

  if (config.perRunUsd !== null) {
    console.log(
      `💰 Spend cap: $${config.perRunUsd.toFixed(2)} per run (${PER_RUN_CAP_ENV}). ` +
        "No supported harness can cancel in-flight sessions on spend, so this is an " +
        "admission/post-run cap: offending runs finish and are recorded, then flagged.",
    );
  }
  if (config.perDayUsd !== null) {
    console.log(
      `💰 Spend cap: $${config.perDayUsd.toFixed(2)} per UTC day across unattended runs ` +
        `(${PER_DAY_CAP_ENV}); checked before every new run.`,
    );
  }

  // Post-run per-run-cap enforcement (runs recorded by THIS process).
  onRunFinished((usage) => ensureGate()?.noteRunFinished(usage));
}

/** The active gate, or null outside the worker / without configured caps. */
export function getWorkerBudget(): BudgetGate | null {
  return ensureGate();
}

/**
 * Shared admission boundary for every unattended agent run.
 *
 * Returns null when gating does not apply (manual runs, no caps configured).
 * Callers must treat `{ allowed: false }` as final for this attempt: skip
 * the work gracefully, leaving it queued/detected for later processing.
 *
 * Emits exactly one capped-state notification per UTC day when the daily cap
 * blocks (cap type, limit, observed spend, reset condition, unknown-cost
 * caveat), then stays silent while the state persists.
 */
export function checkWorkerAdmission(nowMs: number = Date.now()): AdmissionDecision | null {
  const gate = isWorkerProcess() ? ensureGate() : null;
  if (!gate) {
    return null;
  }
  const decision = gate.checkAdmission(nowMs);
  if (!decision.allowed) {
    emitCappedNotice(decision, nowMs);
  }
  return decision;
}

function emitCappedNotice(
  decision: Extract<AdmissionDecision, { allowed: false }>,
  nowMs = Date.now(),
): void {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (lastCappedNoticeDay === day) {
    return; // already announced today — no repeated log spam
  }
  lastCappedNoticeDay = day;
  console.warn(
    `⏸️  [budget] ${ensureGate()?.describeCappedState(decision) ?? "spend cap reached"}`,
  );
}

/** Test/reset hook: clears the singleton between scenarios. */
export function resetWorkerBudgetForTests(): void {
  activeGate = null;
  activeConfig = null;
  lastCappedNoticeDay = null;
}
