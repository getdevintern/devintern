/**
 * First-run rescue for `devintern <TASK-KEY>` without configuration.
 *
 * Instead of dying with a list of missing environment variables, an
 * interactive terminal user is offered the `devintern init` wizard inline;
 * after it completes, the environment is reloaded and the run proceeds.
 *
 * The decision logic is dependency-injected so it is unit-testable without a
 * TTY, a real wizard, or real environment mutation.
 */

import { PromptAttemptsExceededError } from "@devintern/task-trackers";
import type { LogFn } from "@devintern/task-trackers";
import { isPromptAbort, promptAbortReason } from "../cli/prompt-abort";
import { trackSetupDeclined, trackSetupFailed } from "../observability/analytics";
import { TRACKER_CAPABILITIES } from "../trackers/capabilities";

/** Outcome of the first-run configuration check. */
export type FirstRunOutcome = "ready" | "failed";

export interface FirstRunDeps {
  /** Environment snapshot; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Whether stdin is a TTY (interactive terminal). */
  stdinIsTTY?: boolean;
  /** Whether the session looks automated (CI, non-interactive shell). */
  automated?: boolean;
  /** Reads one line of input; defaults to node:readline over stdin. */
  prompt?: (question: string) => Promise<string>;
  /** Runs the interactive init wizard; defaults to the real one. */
  runWizard?: () => Promise<void>;
  /** Reloads tracker credentials after the wizard wrote config. */
  reloadEnv?: () => void | Promise<void>;
  log?: LogFn;
}

/** Required tracker env vars that are not set in the given snapshot. */
export function missingTrackerEnv(
  env: Record<string, string | undefined>,
): Array<{ trackerType: string; displayName: string; missing: string[] }> {
  const trackerType = (env.TASK_TRACKER || "jira").toLowerCase();
  const capabilities = TRACKER_CAPABILITIES[trackerType];
  if (!capabilities) {
    return [{ trackerType, displayName: trackerType, missing: ["TASK_TRACKER"] }];
  }
  const missing = capabilities.requiredEnv.filter((key) => !env[key]);
  return missing.length > 0
    ? [{ trackerType, displayName: capabilities.displayName, missing }]
    : [];
}

function defaultPrompt(question: string): Promise<string> {
  return import("node:readline/promises").then(({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(question).finally(() => rl.close());
  });
}

/**
 * Offer the setup wizard when tracker credentials are missing, then report
 * whether the run can proceed. Never exits the process; callers decide how
 * to surface "failed" (typically via `validateEnvironment()`).
 */
export async function ensureTrackerEnvConfigured(
  deps: FirstRunDeps = {},
): Promise<FirstRunOutcome> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const interactive = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);

  let missing = missingTrackerEnv(env);
  if (missing.length === 0) {
    return "ready";
  }
  if (!interactive || deps.automated) {
    return "failed";
  }

  const problems = missing.map((m) => `${m.displayName}: ${m.missing.join(", ")}`).join("; ");
  log("\n👋 This project has no working devintern configuration yet.");
  log(`   Missing credentials — ${problems}`);

  const prompt = deps.prompt ?? defaultPrompt;
  let answer: string;
  try {
    answer = await prompt("Run the guided setup now? Takes about a minute. [Y/n] ");
  } catch (error) {
    if (!isPromptAbort(error)) throw error;
    log(`\n❌ ${promptAbortReason(error)}; setup skipped. Run \`devintern init\` to configure.`);
    return "failed";
  }
  if (answer.trim().toLowerCase() === "n") {
    // Await the capture so the event is queued before the caller's exit path
    // flushes analytics (the offer is followed by validateEnvironment()).
    await trackSetupDeclined("missing_tracker_credentials");
    return "failed";
  }

  const runWizard =
    deps.runWizard ??
    (async () => {
      const { runInitWizard } = await import("./wizard");
      await runInitWizard({ source: "rescue" });
    });
  try {
    await runWizard();
  } catch (error) {
    // Closed input (Ctrl+D) and a prompt that keeps returning unusable input
    // are user actions, not crashes: keep them out of main()'s error path.
    // Credentials written before the stop still count, so fall through to the
    // reload and re-check below.
    if (error instanceof PromptAttemptsExceededError) {
      log(`\n❌ ${error.message}; setup stopped. Run \`devintern init\` to finish.`);
    } else if (isPromptAbort(error)) {
      log(`\n❌ ${promptAbortReason(error)}; setup stopped. Run \`devintern init\` to finish.`);
    } else {
      throw error;
    }
  }

  await deps.reloadEnv?.();
  // In production `env` is `process.env` by reference, so the reload above
  // (dotenv merge) is visible here; tests mutate their snapshot instead.
  missing = missingTrackerEnv(env);
  if (missing.length > 0) {
    await trackSetupFailed("missing_tracker_credentials");
    return "failed";
  }
  return "ready";
}
