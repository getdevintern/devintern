/**
 * Interactive `devintern worker init`: guided unattended-worker setup.
 *
 * Writes a workspace (first import is N=1) instead of `WORKER_TASK_QUERY` in
 * `.env`, dry-runs the ready-tasks query, checks any automation license,
 * offers Sentry auto-fixes, relay pairing plus the central DevIntern App
 * (@mention events), and can install and launch a native user service
 * (systemd on Linux, launchd on macOS) — or just write its definition and
 * print the manual steps. Polling is always on; direct webhooks run as a
 * separate advanced service.
 *
 * Prompt-loop mechanics come from `@devintern/task-trackers` (shared with
 * `devintern init`); everything effectful is injectable for tests.
 */

import { randomBytes } from "crypto";

import { findProjectRoot } from "@devintern/utils";

import { WORKER_PILOT_OFFER } from "../account/worker-pilot";
import {
  isPromptAbort,
  isPromptAbortReported,
  markPromptAbortReported,
  promptAbortReason,
} from "../cli/prompt-abort";
import { resolveWizardPrompts } from "../cli/prompt-session";
import { GITHUB_APP_INSTALL_URL } from "../code-host/github/app-setup";
import { trackWorkerInitCompleted, trackWorkerInitStarted } from "../observability/analytics";
import { SERVICE_RESTART_COMMAND, dashboardUrlFor } from "../worker/service-report";
import { workspaceConfigPath } from "../workspace/paths";
import { offerFirstTask, sampleTaskAddCommand } from "./worker-init-first-task";
import { emptyOutcome } from "./worker-init-run";
import type { PromptRun, WorkerInitDeps, WorkerInitResult } from "./worker-init-run";
import { runWorkerInitSteps } from "./worker-init-steps";

export { renderLaunchdPlist, renderSystemdUnit } from "../worker/service";
export {
  checkWorkerEntitlement,
  copyProjectSessionToWorkspace,
  workerAuthSessionPath,
  workspaceGitHubRepos,
} from "./worker-init-activation";
export type { LogFn, PromptFn } from "./worker-init-policy";
export {
  RECOMMENDED_WORKER_POLICY,
  RECOMMENDED_WORKER_SETTINGS_SUMMARY,
  askYesNo,
  configureWorkerOperatingPolicy,
  describeCustomWorkerSettings,
} from "./worker-init-policy";
export type { WorkerInitDeps, WorkerInitResult } from "./worker-init-run";
export { WORKER_INIT_STEPS, defaultEnsureTracker } from "./worker-init-steps";
export { describeQueryFailure } from "./worker-init-query-failure";

/**
 * Insert or update KEY=value lines in an env file's content. Existing keys
 * are updated in place (even when commented out); new keys are appended under
 * a worker section header.
 *
 * @param content - Current `.env` content
 * @param vars - Key/value pairs to write
 */
export function upsertEnvVars(content: string, vars: Record<string, string>): string {
  const lines = content.split("\n");
  const pending = new Map(Object.entries(vars));

  const updated = lines.map((line) => {
    const match = line.match(/^\s*#?\s*([A-Z0-9_]+)=/);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  if (pending.size > 0) {
    if (updated.at(-1)?.trim() !== "") {
      updated.push("");
    }
    updated.push("# Worker daemon (devintern worker) — written by 'devintern worker init'");
    for (const [key, value] of pending) {
      updated.push(`${key}=${value}`);
    }
    updated.push("");
  }

  return updated.join("\n");
}

/** Generate a webhook signing secret (hex, 32 bytes). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Print the closing summary and the GitHub App / relay guidance. */
function logWorkerNextSteps(ctx: PromptRun): void {
  const { relayConnected, blockers, githubApp, service } = ctx.outcome;
  const { serviceRunning } = service;
  const serviceInstalled = service.serviceInstalled === true;
  if (blockers.length === 0 && serviceInstalled && !serviceRunning) {
    ctx.log(
      "\n⚠️  Worker setup saved, but the service has not confirmed a running worker (see above).",
    );
    ctx.log("   Check it with `devintern worker service status`; after a fix:");
    ctx.log(`   ${SERVICE_RESTART_COMMAND}`);
  } else if (blockers.length > 0) {
    // Same wording as `worker doctor` and `worker init --non-interactive`:
    // a missing sign-in is one step left, not a broken setup.
    ctx.log(
      blockers.every((blocker) => blocker.action)
        ? `\n👉 Worker setup saved. One step left: sign in to begin your ${WORKER_PILOT_OFFER}.`
        : "\n⚠️  Worker setup saved, but the worker is not ready yet. Next steps:",
    );
    blockers.forEach((blocker, index) => ctx.log(`   ${index + 1}. ${blocker.text}`));
    ctx.log(
      `   ${blockers.length + 1}. Check again with \`devintern worker doctor\`, then ` +
        (serviceRunning || serviceInstalled
          ? `restart the service: ${SERVICE_RESTART_COMMAND}`
          : "install the background service with `devintern worker service install` (or run `devintern worker` in a terminal)."),
    );
  } else {
    ctx.log("\n🎉 Worker setup complete — the worker is ready.");
    ctx.log("\n📝 Next steps:");
    if (serviceRunning) {
      ctx.log("   1. The worker is already running as your user service.");
    } else {
      ctx.log("   1. Run `devintern worker`.");
    }
    ctx.log(
      `   2. Open ${dashboardUrlFor(ctx.workspaceDir) ?? "the dashboard"} to see worker status and runs.`,
    );
    ctx.log("   3. Tasks matching your query use managed clones — your checkout is left alone.");
    if (!serviceRunning) {
      ctx.log(
        `   4. Once it runs, try a sample task: ${sampleTaskAddCommand(ctx.workspaceDir, ctx.repoName)}`,
      );
    }
  }
  if (githubApp !== "skipped") return;

  if (relayConnected) {
    ctx.log("\n⚠️  Central GitHub App events are not enabled:");
    ctx.log("   @mentions on PRs this worker did not create will not fire.");
    if (ctx.githubAppMissing && ctx.githubAppMissing.length > 0) {
      ctx.log(`   The App installation did not grant: ${ctx.githubAppMissing.join(", ")}.`);
      ctx.log(
        "   Add them to the App installation, then run `devintern worker connect github` again.",
      );
    } else if (ctx.githubAppUrl && ctx.githubAppWait === "skipped") {
      ctx.log(
        `   Approve the App at ${ctx.githubAppUrl}, then run \`devintern worker connect github --status\`.`,
      );
    } else {
      ctx.log(
        `   Run \`devintern worker connect github\` to print the App install address and wait for it, ` +
          `or install ${GITHUB_APP_INSTALL_URL} on your repositories.`,
      );
    }
  } else {
    ctx.log("\nℹ️  Running without relay or a custom GitHub App:");
    ctx.log("   GITHUB_TOKEN polling still handles the worker's own PRs.");
    ctx.log("   See the advanced GitHub integration guide if this installation must stay offline.");
  }
}

/**
 * Run the guided worker setup: {@link WORKER_INIT_STEPS} with prompts as the
 * input source, then the closing summary.
 *
 * @returns ok when setup completed and the workspace was written; ready when
 *   nothing found by the closing checks keeps the worker from running
 */
export async function runWorkerInit(deps: WorkerInitDeps = {}): Promise<WorkerInitResult> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const session = await resolveWizardPrompts(deps);
  const run: PromptRun = {
    input: "prompt",
    deps,
    cwd,
    projectRoot: findProjectRoot({ startDir: cwd }),
    log,
    prompt: session.prompt,
    promptSecret: session.promptSecret,
    guard: session.guard,
    trackerType: "",
    trackerName: "",
    workspaceDir: "",
    outcome: emptyOutcome(),
  };

  try {
    log("👷 Setting up the unattended devintern worker.");
    trackWorkerInitStarted();
    if (!(await runWorkerInitSteps(run))) return { ok: false, ready: false };

    logWorkerNextSteps(run);
    const { outcome } = run;
    if (deps.firstTask && outcome.service.serviceRunning && outcome.blockers.length === 0) {
      await offerFirstTask({
        trackerType: run.trackerType,
        trackerName: run.trackerName,
        workspaceDir: run.workspaceDir,
        ...(run.repoName ? { repoName: run.repoName } : {}),
        log,
        prompt: run.prompt,
        env: process.env,
        deps: deps.firstTask,
      });
    }
    trackWorkerInitCompleted({
      tracker: run.trackerType,
      relayConnect: outcome.relayConnect,
      serviceInstall: outcome.service.serviceInstall,
      githubApp: outcome.githubApp,
    });
    return {
      ok: true,
      ready: outcome.blockers.length === 0,
      signInOnly:
        outcome.blockers.length > 0 && outcome.blockers.every((blocker) => blocker.action),
    };
  } catch (error) {
    if (isPromptAbort(error) && run.workspaceDir) {
      log(
        `\n⏸️  Setup paused. Your answers so far are saved in ${workspaceConfigPath(run.workspaceDir)}; ` +
          "run `devintern worker init` to continue (it offers them as defaults).",
      );
      markPromptAbortReported(error);
    }
    throw error;
  } finally {
    session.close();
  }
}

/**
 * Closing report for an aborted `devintern worker init`. The wizard marks the
 * aborts it already explained with a "Setup paused" line, so only an abort
 * raised before the wizard could report it gets the generic "setup stopped"
 * line. Kept here, next to the wizard output, so both halves are testable
 * together.
 *
 * @param error - The abort that ended setup
 * @param log - Output sink (the CLI's `console.log`)
 * @returns Process exit code (always `1`)
 */
export function reportWorkerInitAbort(error: unknown, log: (message: string) => void): number {
  if (!isPromptAbortReported(error)) {
    log(`\n❌ ${promptAbortReason(error)}; setup stopped. Re-run \`devintern worker init\`.`);
  }
  return 1;
}
