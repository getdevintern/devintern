/**
 * Core types for the extensible task pipeline.
 *
 * A pipeline is an ordered list of {@link PipelineStep}s that share one
 * mutable {@link TaskContext}. Steps signal outcomes via {@link StepResult}:
 *
 * - Execution failures (subprocess crashed, unparseable verdict JSON, ...)
 *   are **thrown** as {@link StepExecutionError} and retried by the runner.
 * - Verdict failures (requirements genuinely not met) are **returned** as
 *   `status: "loopback"` so the runner can re-run an earlier step with the
 *   findings, bounded by `maxLoopbacks`.
 */

import type { AgentHarness } from "@devintern/agent-harness";
import type { ProjectSettings } from "../../types/settings";
import type { ReviewFeedback } from "../../types/auto-review";
import type { TaskTrackerClient } from "../task-tracker-client";

/** Outcome of a single pipeline step. */
export enum StepStatus {
  /** Step succeeded; run the next step. */
  Continue = "continue",
  /** Stop the pipeline. See {@link StepResult.haltKind}. */
  Halt = "halt",
  /** Record a warning and run the next step. */
  WarnContinue = "warn",
  /** Jump back to an earlier step (bounded), carrying feedback. */
  Loopback = "loopback",
}

/**
 * How a {@link StepStatus.Halt} is handled by the runner:
 * - `"incomplete"` (default): the task genuinely failed - the runner invokes
 *   the `onHalt` callback (post incomplete-implementation comment, revert the
 *   ticket to To Do).
 * - `"stop"`: stop the pipeline without marking the task incomplete (e.g. a
 *   pre-push hook could not be fixed; today's behavior is to stop quietly).
 */
export type HaltKind = "incomplete" | "stop";

/** Result returned by {@link PipelineStep.run}. */
export interface StepResult {
  status: StepStatus;
  /** Halt reason / warning note (also used in ticket comments and logs). */
  reason?: string;
  /** Halt flavor; defaults to `"incomplete"`. Only meaningful for Halt. */
  haltKind?: HaltKind;
  /** Loopback target step name (defaults to `"implement"`). */
  loopbackTo?: string;
  /** Structured findings handed to the loopback target via `ctx.loopbackFeedback`. */
  loopbackFeedback?: ReviewFeedback;
  /** Per-step loopback bound (defaults to the runner's `defaultMaxLoopbacks`). */
  maxLoopbacks?: number;
  /** Arbitrary step-specific data, recorded in `ctx.results`. */
  data?: Record<string, unknown>;
}

/**
 * Thrown by steps for retryable execution failures (agent subprocess failed,
 * verdict JSON unparseable, diff unavailable). The runner retries the step up
 * to its retry limit, then halts.
 */
export class StepExecutionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StepExecutionError";
  }
}

/** A single unit of work in the task pipeline. */
export interface PipelineStep {
  readonly name: string;
  run(ctx: TaskContext): Promise<StepResult>;
}

/**
 * Factory for pipeline steps. Registered in the step registry and referenced
 * from `settings.json` via `{ "use": "<name>", ...config }`.
 */
export interface StepDefinition {
  readonly name: string;
  create(config: Record<string, unknown>): PipelineStep;
}

/**
 * Mutable state threaded through every step of a task run.
 */
export interface TaskContext {
  // --- Task identity -------------------------------------------------------
  /** Task tracker issue key (absent for some ad-hoc runs). */
  taskKey?: string;
  /** Issue summary used for commit messages and comments. */
  taskSummary?: string;
  /** Raw tracker task object (used for PR creation and description extraction). */
  // oxlint-disable-next-line no-explicit-any
  task?: any;

  // --- Files / directories -------------------------------------------------
  /** Path to the formatted task markdown prompt. */
  taskFile: string;
  /** Contents of {@link taskFile}. */
  taskContent: string;
  /** Per-task output directory (summaries, artifacts, logs). */
  taskDir: string;
  /** Git working directory for the run. */
  workingDir: string;

  // --- Agent ---------------------------------------------------------------
  harness: AgentHarness;
  executablePath: string;
  maxTurns: number;

  // --- Tracker / settings --------------------------------------------------
  tracker?: TaskTrackerClient;
  projectSettings: ProjectSettings | null;
  prTargetBranch: string;
  hookRetries: number;
  gitAuthor?: { name: string; email: string };

  // --- Flags ---------------------------------------------------------------
  enableGit: boolean;
  createPr: boolean;
  skipComments: boolean;
  autoReview: boolean;
  autoReviewIterations: number;
  skipClarityCheck: boolean;
  verbose: boolean;

  // --- Mutable run state ---------------------------------------------------
  /** Stdout of the most recent implementation agent run. */
  implementationOutput: string;
  /** Whether the current implement run is a plan-only retry. */
  isPlanRetry: boolean;
  /** Findings handed to the implement step by a loopback (consumed + cleared). */
  loopbackFeedback?: ReviewFeedback;
  /** Full prompt override for the next implement run (consumed + cleared). */
  pendingPromptOverride?: string;
  /** Set by the commit step when changes were committed. */
  commitSucceeded: boolean;
  /** Set by the auto-review step after a successful review loop. */
  autoReviewRan: boolean;
  /** Set once the pre-push hook has been validated locally in this run. */
  hookValidated: boolean;

  // --- Bookkeeping ---------------------------------------------------------
  results: StepResult[];
  warnings: string[];
}
