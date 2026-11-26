/**
 * Next steps and the `--env-file` follow-up of `worker init --non-interactive`.
 * Every command runs as written on a host without a terminal.
 */

import { rmSync } from "fs";
import { resolve } from "path";

import type { PendingSignIn } from "../account/cli";
import { shellQuote, workspaceEnvPrefixFor } from "../account/worker-pilot";
import type { ReadinessCheck } from "../observability/readiness";
import { blockerNextSteps, connectStep, serviceStep } from "../observability/readiness-json";
import type { ReadinessResult } from "../observability/readiness-json";
import { hasGitHubRelayRegistration, loadRelayState } from "../relay/connect";
import { workspaceEnvPath } from "../workspace/paths";
import { errorMessage } from "./worker-init-fs";
import type { Plan } from "./worker-init-noninteractive-plan";
import type {
  Env,
  InitCheck,
  InitNextStep,
  NonInteractiveInitArgs,
  NonInteractiveInitReport,
} from "./worker-init-noninteractive-types";

/** A report check as a readiness row, for the shared next-step builder. */
function asReadinessCheck(check: InitCheck): ReadinessCheck {
  return {
    id: check.name,
    label: check.label,
    status:
      check.status === "pass" || check.status === "skipped"
        ? "ok"
        : check.status === "warn" || check.status === "action"
          ? check.status
          : "fail",
    detail: check.message,
    ...(check.hint ? { hint: check.hint } : {}),
  };
}

/**
 * This command again, runnable as written: absolute `--env-file`, `cd` into
 * the checkout for `--repo-from-cwd`, `DEVINTERN_WORKSPACE_DIR` for a
 * non-default workspace, and `--yes --json`.
 */
export function initRerunCommand(
  args: NonInteractiveInitArgs,
  ctx: { cwd: string; workspaceDir: string; envFilePath?: string; home?: string },
  overrides: { taskQuery?: string; envFile?: string } = {},
): string {
  const parts = [
    `${workspaceEnvPrefixFor(ctx.workspaceDir, ctx.home)}devintern worker init --non-interactive`,
  ];
  if (args.tracker) parts.push(`--tracker ${shellQuote(args.tracker)}`);
  const taskQuery = overrides.taskQuery ?? args.taskQuery;
  if (taskQuery) {
    parts.push(`--task-query ${shellQuote(taskQuery)}`);
  }
  if (args.repoFromCwd) parts.push("--repo-from-cwd");
  const envFile = overrides.envFile ?? ctx.envFilePath;
  if (envFile) parts.push(`--env-file ${envFile.startsWith("<") ? envFile : shellQuote(envFile)}`);
  if (args.signIn) {
    parts.push(
      `--sign-in ${shellQuote(args.signIn.method === "email" ? (args.signIn.email ?? "email") : args.signIn.method)}`,
    );
  }
  parts.push("--yes --json");
  const command = parts.join(" ");
  return args.repoFromCwd ? `cd ${shellQuote(ctx.cwd)} && ${command}` : command;
}

export function nextStepsFor(options: {
  args: NonInteractiveInitArgs;
  cwd: string;
  workspaceDir: string;
  hasRepo: boolean;
  signIn?: PendingSignIn;
  /** False when a failed check made the run restore what it wrote: fixes re-run setup. */
  persisted: boolean;
  /** The report's checks: a failed check withholds `service` and `connect`. */
  checks: readonly InitCheck[];
  /** Env the harness check resolved `AGENT_HARNESS` from. */
  env: Env;
  envFilePath?: string;
  home?: string;
  which?: (command: string) => string | null;
}): InitNextStep[] {
  const { args, workspaceDir, home } = options;
  const ctx = { cwd: options.cwd, workspaceDir, envFilePath: options.envFilePath, home };
  const failed = options.checks.some((check) => check.status === "fail");
  const rerun = initRerunCommand(args, ctx);
  const steps: InitNextStep[] = [];
  if (options.signIn) {
    steps.push({
      id: "complete-sign-in",
      message:
        "A person opens the sign-in url in any browser and signs in. The browser then lands on a " +
        "127.0.0.1 page that does not load: pass that page's full address to this command on this host",
      command: options.signIn.complete,
      ...(options.signIn.url ? { url: options.signIn.url } : {}),
    });
  }
  const blockers = options.checks
    .filter((check) => check.status === "fail" || check.status === "action")
    .filter(
      (check) => !(options.signIn && check.name === "entitlement" && check.status === "action"),
    )
    .map(asReadinessCheck);
  steps.push(
    ...blockerNextSteps(blockers, {
      workspaceDir,
      env: options.env,
      home,
      which: options.which,
      fixes: {
        credentials: initRerunCommand(args, ctx, {
          envFile: options.envFilePath ?? "<path>",
        }),
        query: initRerunCommand(args, ctx, { taskQuery: "<query>" }),
        // Nothing was saved: re-run setup, not doctor.
        ...(options.persisted ? {} : { recheck: rerun }),
      },
    }),
  );
  if (!options.hasRepo) {
    steps.push({
      id: "add-repo",
      message: "Register a repository: run this inside its checkout",
      command: `${workspaceEnvPrefixFor(workspaceDir, home)}devintern worker init --non-interactive --yes --repo-from-cwd --json`,
    });
  }
  if (failed) {
    const mentioned = steps.some((step) => step.command === rerun || step.message.includes(rerun));
    if (!options.persisted && !mentioned) {
      steps.push({
        id: "retry",
        message: "Nothing was saved. After the fixes above, re-run setup",
        command: rerun,
      });
    }
    return steps;
  }
  steps.push(serviceStep(workspaceDir, home));
  let relayConnected = false;
  try {
    relayConnected = hasGitHubRelayRegistration(loadRelayState(workspaceDir));
  } catch {
    relayConnected = false;
  }
  if (!relayConnected) steps.push(connectStep(workspaceDir, home));
  return steps;
}

/**
 * The `--env-file` is the user's file: say it can go once its values are
 * saved, or delete it when `--remove-env-file` asked for that. Never deleted
 * after a failure, and never touched when nothing was saved or when it is the
 * workspace `.env` itself.
 */
export function handleEnvFile(
  args: NonInteractiveInitArgs,
  plan: Plan,
  report: NonInteractiveInitReport,
  result: ReadinessResult,
  workspaceDir: string,
  log: (message: string) => void,
): void {
  const path = plan.envFilePath;
  const workspaceEnv = workspaceEnvPath(workspaceDir);
  if (!path || !report.persisted || resolve(path) === resolve(workspaceEnv)) return;
  if (args.removeEnvFile && result !== "failure") {
    try {
      rmSync(path, { force: true });
      report.envFileRemoved = true;
      log(`🗑️  Removed ${path} (--remove-env-file); the values are saved in ${workspaceEnv}`);
    } catch (error) {
      report.warnings.push(`Could not remove ${path}: ${errorMessage(error)}`);
    }
    return;
  }
  report.warnings.push(
    `${path} still holds the credentials; they are saved in ${workspaceEnv} now. Delete it when ` +
      `you no longer need it (rm ${shellQuote(path)}), or pass --remove-env-file next time.`,
  );
}
