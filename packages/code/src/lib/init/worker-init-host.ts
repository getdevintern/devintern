/**
 * Host checks for `devintern worker init`: can this machine run the worker at
 * all? The wizard runs them before its first question, so a missing agent CLI
 * or git is reported before the user answers anything. Flags mode has no
 * separate step: its readiness checks include the harness check, and the text
 * report lists host problems first.
 */

import { existsSync } from "fs";

import { trackWorkerInitFailed } from "../observability/analytics";
import { defaultCheckHarness } from "../observability/harness-readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { installAgentStep } from "../observability/readiness-json";
import { checkServiceManager } from "../worker/service";
import { parseEnvFile } from "../workspace/env";
import { resolveWorkspaceDir, workspaceEnvPath } from "../workspace/paths";
import { askYesNo } from "./worker-init-policy";
import type { HostChecks, HostReport, SetupRun } from "./worker-init-run";

type Env = Record<string, string | undefined>;

/**
 * Default host checks: the doctor's harness check against the worker's
 * environment (process env plus the workspace `.env` when it exists), git on
 * PATH, and the service manager unless the service step is skipped.
 */
export async function defaultCheckHost(
  options: {
    processEnv?: Env;
    workspaceDir?: string;
    platform?: NodeJS.Platform;
    noService?: boolean;
    which?: (command: string) => string | null;
  } = {},
): Promise<HostChecks> {
  const processEnv = options.processEnv ?? process.env;
  const workspaceDir = options.workspaceDir ?? resolveWorkspaceDir();
  const envPath = workspaceEnvPath(workspaceDir);
  const env: Env = { ...processEnv, ...(existsSync(envPath) ? parseEnvFile(envPath) : {}) };
  const which =
    options.which ??
    ((command: string) => Bun.which(command, env.PATH ? { PATH: env.PATH } : undefined));
  const harness = await defaultCheckHarness(env);
  const platform = options.platform ?? process.platform;
  const checkService = !options.noService && (platform === "linux" || platform === "darwin");
  return {
    harness,
    git: which("git"),
    ...(checkService ? { serviceManager: await checkServiceManager({ platform }) } : {}),
    ...(harness.status === "fail"
      ? { installAgent: installAgentStep(env, { which, thenCommand: "devintern worker doctor" }) }
      : {}),
  };
}

/**
 * Wizard step before the tracker: report the host checks and, when the agent
 * CLI or git is missing, offer to continue anyway or stop. Runs only when the
 * caller supplies `checkHost` (the CLI does); flags mode reports the same
 * harness check with its readiness checks instead.
 */
export async function hostStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags" || !run.deps.checkHost) return true;
  let checks: HostChecks;
  try {
    checks = await run.deps.checkHost();
  } catch (error) {
    run.log(`\n⚠️  Could not check this host: ${(error as Error).message}`);
    return true;
  }
  const { harness, git, serviceManager, installAgent } = checks;
  run.log("\n🔎 This host");
  const harnessFailed = harness.status === "fail";
  if (harnessFailed) {
    run.log(`   ❌ Agent CLI: ${harness.detail ?? "not found"}`);
    if (installAgent) {
      run.log(`      ${installAgent.message}`);
      run.log(
        `      ${installAgent.url ? "Instructions" : "Install it with"}: ${installAgent.command}`,
      );
    } else if (harness.hint) {
      run.log(`      ${harness.hint}`);
    }
  } else if (harness.status === "warn") {
    run.log(`   ⚠️  Agent CLI: ${harness.detail ?? ""}`);
    if (harness.hint) run.log(`      ${harness.hint}`);
  } else {
    run.log(`   ✅ Agent CLI: ${harness.detail ?? "found"}`);
  }
  if (git) {
    run.log(`   ✅ git: ${git}`);
  } else {
    run.log(
      "   ❌ git: not found on PATH. The worker clones and pushes with git; install it first.",
    );
  }
  if (serviceManager) {
    run.log(
      serviceManager.available
        ? "   ✅ Background service: available"
        : `   ℹ️  Background service: not available here (${serviceManager.reason}); run \`devintern worker\` in a terminal instead.`,
    );
  }
  run.host = { checks, harnessReported: harnessFailed };

  if (!harnessFailed && git) return true;
  const missing = [harnessFailed ? "the agent CLI" : "", git ? "" : "git"]
    .filter(Boolean)
    .join(" and ");
  if (
    await askYesNo(
      run,
      `Continue setup without ${missing}? The worker cannot run tasks until it is installed. [Y/n]: `,
      true,
    )
  ) {
    return true;
  }
  run.log(`   Setup stopped. Install ${missing}, then run \`devintern worker init\` again.`);
  trackWorkerInitFailed("host_check_declined");
  return false;
}

/**
 * The readiness rows as the wizard shows them after the host step: a harness
 * failure it already reported keeps its row and status, but not its hint.
 */
export function withoutRepeatedHostFailures(
  checks: ReadinessCheck[],
  host: HostReport | undefined,
): ReadinessCheck[] {
  if (!host?.harnessReported) return checks;
  return checks.map((check) =>
    check.id === "harness" && check.status === "fail"
      ? { ...check, detail: "still missing (see the host check at the start)", hint: undefined }
      : check,
  );
}
