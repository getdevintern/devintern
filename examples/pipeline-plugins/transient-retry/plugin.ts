/**
 * transient-retry — demonstrate `StepExecutionError` retry semantics.
 *
 * A step that throws `StepExecutionError` is retried exactly once by the runner.
 * A second throw halts the pipeline. This models a transient infrastructure
 * failure (a flaky remote, a momentarily unavailable dependency) — it is *not*
 * for a failing test or a policy verdict, which are permanent findings and
 * should return `{ kind: "halt" }` instead.
 *
 * The example counts down a persisted counter so the behavior is deterministic
 * without touching the network. Copy it to `~/.devintern/pipelines/steps/` and
 * register it in a workspace pipeline file (see pipeline.json here).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { StepExecutionError } from "@getdevintern/code/pipeline";
import type { PipelineContext, StepDefinition, TaskStepResult } from "@getdevintern/code/pipeline";

interface TransientRetryOptions {
  /** Counter file, relative to `context.workingDir`. */
  statePath?: string;
  /** Transient failures to simulate before succeeding. Defaults to 0. */
  failures?: number;
  /** Return a permanent `halt` instead of throwing, to show the difference. */
  permanentFailure?: boolean;
}

interface RetryState {
  remaining: number;
  attempts: number;
}

/** Default counter file: the workspace's `state/`, outside the repository. */
const DEFAULT_STATE_PATH = join(
  process.env.DEVINTERN_WORKSPACE_DIR?.trim() || join(homedir(), ".devintern"),
  "state",
  "transient-retry-state.json",
);

function readState(file: string, initialFailures: number): RetryState {
  if (!existsSync(file)) return { remaining: initialFailures, attempts: 0 };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RetryState>;
    return {
      remaining: typeof parsed.remaining === "number" ? parsed.remaining : initialFailures,
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
    };
  } catch {
    return { remaining: initialFailures, attempts: 0 };
  }
}

function writeState(file: string, state: RetryState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state)}\n`, "utf8");
}

const definition: StepDefinition = {
  name: "transient-retry",
  create(config) {
    const options = config as TransientRetryOptions;
    const statePath = options.statePath ?? DEFAULT_STATE_PATH;
    const initialFailures =
      typeof options.failures === "number" && Number.isSafeInteger(options.failures)
        ? Math.max(0, options.failures)
        : 0;

    return {
      name: "transient-retry",
      async run(context: PipelineContext): Promise<TaskStepResult> {
        if (options.permanentFailure === true) {
          return {
            kind: "halt",
            reason: "Permanent finding from a completed check; no retry is attempted.",
          };
        }

        const file = isAbsolute(statePath) ? statePath : join(context.workingDir, statePath);
        const state = readState(file, initialFailures);
        state.attempts += 1;

        if (state.remaining > 0) {
          state.remaining -= 1;
          writeState(file, state);
          throw new StepExecutionError(
            `Transient remote check failed after attempt ${state.attempts} (${state.remaining} simulated failure(s) left).`,
          );
        }

        writeState(file, state);
        return { kind: "continue", data: { attempts: state.attempts } };
      },
    };
  },
};

export default definition;
