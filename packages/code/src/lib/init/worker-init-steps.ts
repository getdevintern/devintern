/**
 * The one step engine behind `devintern worker init`. Both input sources run
 * the same ordered {@link WORKER_INIT_STEPS}: the interactive wizard
 * (`prompt`, `runWorkerInit`) and `--non-interactive` (`flags`,
 * `runNonInteractiveWorkerInit`). Each step is defined once; where the two
 * differ is how it gets its input (a prompt, or flags and the environment)
 * and where its outcome goes (wizard text, or the JSON report).
 *
 * Writes differ on purpose. The wizard saves each answer as it is given, so a
 * stopped wizard keeps them as the next run's defaults. Flags mode validates
 * every input first, then the save step writes workspace.toml and `.env`
 * atomically under the workspace lock, and a failed input check restores them.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

import {
  MAX_PROMPT_ATTEMPTS,
  condenseMessage,
  createPromptAttempts,
  defaultProbe,
  parseEnvContent,
} from "@devintern/task-trackers";
import { findProjectRoot } from "@devintern/utils";

import {
  WORKER_PILOT_OFFER,
  shellQuote,
  signInCommand,
  workspaceEnvPrefixFor,
} from "../account/worker-pilot";

import { trackWorkerInitFailed } from "../observability/analytics";
import { renderReadinessReport } from "../observability/readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { toReportCheck } from "../observability/readiness-json";
import { collectWorkerDoctorChecks } from "../observability/worker-readiness";
import type { WorkerDoctorDeps } from "../observability/worker-readiness";
import {
  DEVINTERN_LABEL,
  TRACKER_CAPABILITIES,
  defaultQueryZeroMatchHint,
  defaultTaskQuery,
  isDefaultTaskQuery,
  supportsLabelCreation,
  supportsPolling,
  trackersSupportingPolling,
} from "../trackers/capabilities";
import { trackerRequiredEnv } from "../trackers/manager";
import { Utils } from "../utils";
import { writeSecretFile } from "../utils/secret-file";
import { loadWorkspaceConfig } from "../workspace/config";
import {
  ensureWorkspaceAndAddRepo,
  writeWorkerOperatingPolicy,
  writeWorkspaceDefaults,
} from "../workspace/init";
import { gitHubSlugFromRemote } from "../workspace/env";
import { findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import {
  ensureWorkspaceCodeState,
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceEnvPath,
} from "../workspace/paths";
import {
  copyProjectSessionToWorkspace,
  githubAppStep,
  licenseStep,
  relayStep,
  serviceStep,
} from "./worker-init-activation";
import { recordRepoDefaultBranch } from "./worker-init-branch";
import { errorMessage } from "./worker-init-fs";
import { hostStep, withoutRepeatedHostFailures } from "./worker-init-host";
import { defaultDevinternLabelOps } from "./worker-init-label";
import { queryLabelsCheck, reviewQueryLabels } from "./worker-init-query-labels";
import {
  applyPlan,
  planChangesNothing,
  planQuery,
  planTracker,
  planWorkspace,
  renderPlannedConfig,
} from "./worker-init-noninteractive-plan";
import type { Plan, PlanFailure } from "./worker-init-noninteractive-plan";
import type {
  InitCheck,
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
} from "./worker-init-noninteractive-types";
import {
  RECOMMENDED_WORKER_POLICY,
  RECOMMENDED_WORKER_SETTINGS_SUMMARY,
  askYesNo,
  configureWorkerOperatingPolicy,
  describeCustomWorkerSettings,
} from "./worker-init-policy";
import type { LogFn, PromptFn } from "./worker-init-policy";
import { DEFAULT_PROBE_TIMEOUT_MS, secretValues, withTimeout } from "./worker-init-run";
import type { FlagsRun, PromptRun, ReadinessBlocker, SetupRun } from "./worker-init-run";
import { runWorkerSentrySetup } from "./worker-sentry-setup";
import { runTrackerSetup } from "./wizard";

/** The wizard that asks each worker setting one by one. */
const CUSTOMIZE_COMMAND = "devintern worker init --customize";

/** One setup step. Returns false to stop setup (the step has said why). */
export interface WorkerInitStep {
  id: string;
  run: (run: SetupRun) => Promise<boolean>;
}

/** Every `worker init` step, in order, for both input sources. */
export const WORKER_INIT_STEPS: readonly WorkerInitStep[] = [
  { id: "host", run: hostStep },
  { id: "tracker", run: trackerStep },
  { id: "workspace", run: workspaceStep },
  { id: "query", run: queryStep },
  { id: "settings", run: settingsStep },
  { id: "save", run: saveStep },
  { id: "license", run: licenseStep },
  { id: "relay", run: relayStep },
  { id: "github-app", run: githubAppStep },
  { id: "readiness", run: readinessStep },
  { id: "service", run: serviceStep },
];

/** Run {@link WORKER_INIT_STEPS} in order; false when a step stopped setup. */
export async function runWorkerInitSteps(run: SetupRun): Promise<boolean> {
  for (const step of WORKER_INIT_STEPS) {
    if (!(await step.run(run))) return false;
  }
  return true;
}

/** Stop a flags run with a validation failure; a wrong-language query gets its fix. */
function failFlags(run: FlagsRun, failure: PlanFailure): false {
  const nextSteps =
    failure.code === "invalid_query"
      ? [
          {
            id: "fix-query",
            message: "Re-run setup with a query in the tracker's own search syntax",
            command: initRerunCommand(run.args, rerunContext(run, run.draft?.envFilePath), {
              taskQuery: "<query>",
            }),
          },
        ]
      : [];
  Object.assign(run.report, {
    tracker: failure.tracker ?? null,
    error: failure.error,
    code: failure.code,
    ...(failure.missing ? { missing: failure.missing } : {}),
    nextSteps,
  });
  return false;
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
  if (args.createLabel) parts.push("--create-label");
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

/** Context for {@link initRerunCommand}: this command again, runnable as written. */
function rerunContext(run: FlagsRun, envFilePath?: string) {
  return { cwd: run.cwd, workspaceDir: run.workspaceDir, envFilePath, home: run.deps.home };
}

/**
 * Tracker and its credentials. The wizard reuses the tracker config from
 * `devintern init` (or runs that subset); flags mode checks `--tracker` and
 * reads `--env-file`.
 */
async function trackerStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") {
    const planned = planTracker(run.args, run.cwd);
    if (!planned.ok) return failFlags(run, planned);
    run.draft = planned.draft;
    return true;
  }
  run.log("\n1️⃣  Tracker configuration");
  const trackerType = run.deps.ensureTracker
    ? await run.deps.ensureTracker({
        cwd: run.cwd,
        prompt: run.prompt,
        promptSecret: run.promptSecret,
        log: run.log,
      })
    : await defaultEnsureTracker(run.cwd, run.prompt, run.promptSecret, run.log);
  if (!trackerType) {
    run.log("❌ Tracker setup did not finish. Re-run `devintern worker init`.");
    trackWorkerInitFailed("tracker_setup_incomplete");
    return false;
  }
  if (!supportsPolling(trackerType)) {
    run.log(`❌ Tracker '${trackerType}' does not support worker polling.`);
    run.log(`   Pollable trackers: ${trackersSupportingPolling().join(", ")}`);
    trackWorkerInitFailed("tracker_not_pollable");
    return false;
  }
  run.trackerType = trackerType;
  run.trackerName = trackerDisplayName(trackerType);
  run.queryExample = TRACKER_CAPABILITIES[trackerType]?.queryExample;
  run.log(`   Using ${run.trackerName}.`);
  return true;
}

/**
 * Workspace and this repository. The wizard writes the workspace (importing
 * this repo) and guards the one-tracker invariant; flags mode reads the
 * existing workspace.toml and resolves `--repo-from-cwd`.
 */
async function workspaceStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") {
    const failure = await planWorkspace(run.args, run.draft!, run);
    return failure ? failFlags(run, failure) : true;
  }
  run.log("\n2️⃣  Workspace (one daemon; this repo first)");
  const bootstrap =
    run.deps.bootstrapWorkspace ??
    (async (opts) => {
      const result = await ensureWorkspaceAndAddRepo(opts.cwd, opts.log);
      if (!result.ok) {
        return { error: result.error };
      }
      return {
        workspaceDir: result.workspaceDir,
        created: result.created,
        repoName: result.repoName,
      };
    });
  const workspace = await bootstrap({ cwd: run.cwd, log: run.log });
  if ("error" in workspace) {
    run.log(`❌ ${workspace.error}`);
    trackWorkerInitFailed("workspace_error");
    return false;
  }
  const { trackerType } = run;
  if (workspace.created === false) {
    const existing = loadWorkspaceConfig(workspaceConfigPath(workspace.workspaceDir));
    if (existing.defaults.tracker !== trackerType) {
      // A workspace an interrupted `worker init` left behind (no query, no
      // teams) polls no tracker yet, so switching it changes nothing that runs.
      if (existing.defaults.taskQuery || existing.teams.length > 0) {
        run.log(
          `❌ This workspace uses ${existing.defaults.tracker}, but this repo is configured for ${trackerType}.`,
        );
        run.log("   One worker workspace has one active tracker; keep its defaults unchanged.");
        trackWorkerInitFailed("workspace_tracker_mismatch");
        return false;
      }
      // An earlier `worker init` stopped before the query step: nothing
      // polls the old tracker yet, so finish that setup instead of refusing.
      run.log(
        `ℹ️  Finishing an earlier setup that stopped before the query step: tracker ${existing.defaults.tracker} → ${trackerType}.`,
      );
    }
  }
  // Record the tracker now, not with the query: setup stopped at the query
  // prompt must not leave the template's default tracker behind.
  writeWorkspaceDefaults(workspace.workspaceDir, { tracker: trackerType });
  run.workspaceDir = workspace.workspaceDir;
  run.repoName = workspace.repoName;

  if (workspace.repoName) {
    await recordRepoDefaultBranch(run, workspace.workspaceDir, workspace.repoName);
  }

  ensureWorkspaceCodeState(run.workspaceDir);
  try {
    if (copyProjectSessionToWorkspace(run.projectRoot, run.workspaceDir)) {
      run.log("🔑 Reused this project's sign-in for the worker workspace.");
    }
  } catch (error) {
    run.log(`⚠️  Could not copy the project sign-in: ${(error as Error).message}`);
    run.log("   Run `devintern worker login` to sign in for the workspace.");
  }
  return true;
}

/**
 * Ready-tasks query. The wizard prompts (a re-run offers the saved query as
 * the Enter default), validates it with a live dry run, and writes it; flags
 * mode takes `--task-query` and completes the plan with the credentials.
 */
async function queryStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") {
    const planned = planQuery(run.args, run.draft!, run);
    if (!planned.ok) return failFlags(run, planned);
    run.plan = planned.plan;
    return true;
  }
  const { workspaceDir } = run;
  const currentQuery = loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).defaults.taskQuery;
  const query = await promptReadyQuery(run, currentQuery);
  writeWorkspaceDefaults(workspaceDir, { tracker: run.trackerType, taskQuery: query });
  run.log(`💾 Wrote [defaults].task_query to ${join(workspaceDir, "workspace.toml")}`);
  return true;
}

/** Prompt for the ready-tasks query until one is entered (and, with a dry run, works). */
async function promptReadyQuery(run: PromptRun, currentQuery: string | undefined): Promise<string> {
  run.log("\n3️⃣  Which tasks should the worker pick up?");
  // A re-run keeps the saved query as the Enter default; a new workspace
  // offers the tracker's devintern-label query.
  const fallback = currentQuery || defaultTaskQuery(run.trackerType);
  if (currentQuery) {
    run.log("   The query uses the same language as 'devintern --query' for your tracker.");
    run.log("   Press Enter to keep the current query.");
  } else if (fallback) {
    run.log(
      `   Press Enter to pick up open tickets labeled ${DEVINTERN_LABEL}, or type your own query`,
    );
    run.log("   (the same language as 'devintern --query' for your tracker).");
  } else {
    run.log("   The query uses the same language as 'devintern --query' for your tracker.");
    if (run.queryExample) run.log(`   Example: ${run.queryExample}`);
  }

  let query = "";
  const rejectQuery = createPromptAttempts("ready-tasks query");
  for (;;) {
    query =
      (
        await run.prompt(fallback ? `Ready-tasks query [${fallback}]: ` : "Ready-tasks query: ")
      ).trim() ||
      fallback ||
      "";
    if (!query) {
      run.log("❌ A query is required — it defines what 'ready for the agent' means.");
      rejectQuery();
      continue;
    }
    // Offer the devintern label only once the query works; the default query's
    // label is handled there, so the rest are checked afterwards.
    const handled = isDefaultTaskQuery(run.trackerType, query) ? [DEVINTERN_LABEL] : [];
    if (!run.deps.dryRunQuery) {
      await offerDevinternLabel(run, query);
      if ((await reviewQueryLabels(run, query, process.env, handled)) === "fix") {
        rejectQuery(`No usable ready-tasks query after ${MAX_PROMPT_ATTEMPTS} attempts`);
        continue;
      }
      break;
    }
    try {
      const count = await run.deps.dryRunQuery(query);
      run.log(`✅ Query works: ${count} task(s) match right now.`);
      if (count === 0) {
        const labelHint = defaultQueryZeroMatchHint(run.trackerType, query);
        run.log(
          labelHint
            ? `   ${labelHint}.`
            : "   (0 matches is fine if nothing is ready yet — the worker will poll.)",
        );
      }
      await offerDevinternLabel(run, query);
      if ((await reviewQueryLabels(run, query, process.env, handled)) === "fix") {
        rejectQuery(`No usable ready-tasks query after ${MAX_PROMPT_ATTEMPTS} attempts`);
        continue;
      }
      break;
    } catch (error) {
      const failure = describeQueryFailure((error as Error).message, process.env.GITHUB_REPO);
      if (failure.access) {
        // Not the query's fault: editing it cannot help.
        run.log(`❌ ${failure.text}`);
        run.log(
          `   Keeping the query. Fix the token or GITHUB_REPO in ${workspaceEnvPath(resolveWorkspaceDir())}, ` +
            "then check with `devintern worker doctor`.",
        );
        break;
      }
      run.log(`❌ Query failed against ${run.trackerName}: ${failure.text}`);
      if (!(await askYesNo(run, "Edit the query and try again? [Y/n]: ", true))) {
        run.log("   Keeping the query as entered; fix it later in workspace.toml.");
        break;
      }
      rejectQuery(`No working ready-tasks query after ${MAX_PROMPT_ATTEMPTS} attempts`);
    }
  }
  return query;
}

/**
 * With the default query, a tracker that can create labels and lacks the
 * devintern label: ask before creating it (never silently). A failed lookup
 * or creation only warns; the query still works once a ticket is labeled.
 */
async function offerDevinternLabel(run: PromptRun, query: string): Promise<void> {
  const { trackerType, trackerName } = run;
  if (!isDefaultTaskQuery(trackerType, query) || !supportsLabelCreation(trackerType)) return;
  const ops = run.deps.devinternLabelOps?.(trackerType, process.env);
  if (!ops) return;
  try {
    if (await ops.exists()) return;
  } catch (error) {
    run.log(`⚠️  Could not check for the ${DEVINTERN_LABEL} label: ${errorMessage(error)}`);
    return;
  }
  run.log(`   ${trackerName} has no ${DEVINTERN_LABEL} label yet.`);
  if (
    !(await askYesNo(run, `Create the ${DEVINTERN_LABEL} label in ${trackerName}? [Y/n]: `, true))
  ) {
    run.log(`   Not created. Create it in ${trackerName} before labeling tickets.`);
    return;
  }
  try {
    await ops.create();
    run.log(`🏷️  Created the ${DEVINTERN_LABEL} label in ${trackerName}.`);
  } catch (error) {
    run.log(`⚠️  Could not create the ${DEVINTERN_LABEL} label: ${errorMessage(error)}`);
    run.log(`   Create it in ${trackerName} (the token may lack permission to manage labels).`);
  }
}

/**
 * Worker settings. Both sources write the recommended settings explicitly
 * instead of relying on defaults for a workspace without custom settings
 * (flags mode: a new workspace), and keep custom settings as they are, without
 * a question. The wizard's `--customize` asks each setting (CI repair,
 * conflicts, active hours) and offers Sentry instead.
 */
async function settingsStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") {
    run.plan!.writeRecommendedPolicy = run.plan!.configSnapshot === null;
    return true;
  }
  const { workspaceDir } = run;
  run.log("\n4️⃣  Worker settings");
  if (!run.deps.customize) {
    const custom = describeCustomWorkerSettings(
      loadWorkspaceConfig(workspaceConfigPath(workspaceDir)),
    );
    if (custom) {
      run.log(
        `   Kept the current worker settings (${custom}); change them in workspace.toml or with \`${CUSTOMIZE_COMMAND}\`.`,
      );
    } else {
      writeWorkerOperatingPolicy(workspaceDir, { ...RECOMMENDED_WORKER_POLICY, activeWindows: [] });
      run.log(
        `💾 Wrote the recommended worker settings to workspace.toml (${RECOMMENDED_WORKER_SETTINGS_SUMMARY}); change them there or with \`${CUSTOMIZE_COMMAND}\`.`,
      );
    }
    return true;
  }

  run.log("   Choose when new tasks run and how the worker maintains its pull requests.");
  await (run.deps.configureOperatingPolicy ?? configureWorkerOperatingPolicy)({
    workspaceDir,
    prompt: run.prompt,
    log: run.log,
  });

  // Optional production-error source. Tracker tasks remain the worker's
  // primary input; this adds a repo-pinned Sentry project alongside them.
  run.log("\n   Sentry auto-fixes (optional)");
  run.log("   Watch recurring production errors and run fixes through the normal PR pipeline.");
  if (
    await askYesNo(
      run,
      "Watch a Sentry project and create fixes for recurring errors? [y/N]: ",
      false,
    )
  ) {
    await runWorkerSentrySetup({
      workspaceDir,
      repoName: run.repoName,
      prompt: run.prompt,
      promptSecret: run.promptSecret,
      log: run.log,
      validateSentry: run.deps.validateSentry,
    });
  } else {
    run.log("   Sentry auto-fixes skipped; add [[error_monitors]] to workspace.toml later.");
  }
  return true;
}

/**
 * Flags mode writes the validated plan in one atomic save (an existing
 * workspace with other settings needs `--yes`). The wizard has already saved
 * each answer in its own step.
 */
async function saveStep(run: SetupRun): Promise<boolean> {
  if (run.input === "prompt") return true;
  const { args, report, workspaceDir, log } = run;
  const plan = run.plan!;
  run.secrets = secretValues(plan.credentialEnv);
  report.tracker = plan.tracker;
  report.taskQuery = plan.taskQuery;
  for (const note of plan.notes) log(note);

  const unchanged = planChangesNothing(plan, workspaceDir);
  if (plan.configSnapshot !== null && !args.yes && !unchanged) {
    Object.assign(report, {
      code: "workspace_exists",
      error:
        `${workspaceConfigPath(workspaceDir)} already exists with other settings; nothing was ` +
        "changed. Pass --yes to update its tracker, task_query, and repository entries (all " +
        "other settings are kept).",
      nextSteps: [
        {
          id: "update",
          message: "Update the existing workspace with these flags (other settings are kept)",
          command: initRerunCommand(args, rerunContext(run, plan.envFilePath)),
        },
      ],
    });
    return false;
  }

  if (unchanged) {
    report.repo = renderPlannedConfig(plan, plan.configSnapshot).repo;
    log("ℹ️  The workspace already has this setup; nothing to write.");
  } else {
    const applied = applyPlan(plan, workspaceDir);
    if (!applied.ok) {
      Object.assign(report, { error: applied.error, code: applied.code });
      return false;
    }
    run.writes = applied.writes;
    report.filesWritten = applied.filesWritten;
    report.repo = applied.repo;
    for (const file of applied.filesWritten) log(`💾 Wrote ${file}`);
    if (applied.seededProject) log(`   Seeded routing rule: project = ${applied.seededProject}`);
  }
  report.changed = run.writes.length > 0;
  noteRepo(run);
  return true;
}

/** Log the repository entry, and warn when the checkout's branch is not the one PRs target. */
function noteRepo(run: FlagsRun): void {
  const { report, log } = run;
  const repo = report.repo;
  if (!repo) return;
  log(
    repo.added
      ? `✅ Registered ${repo.remote} as "${repo.name}"`
      : `ℹ️  ${repo.remote} is already registered as "${repo.name}"`,
  );
  const { branch, defaultBranch } = repo;
  if (repo.added && branch && defaultBranch && branch !== defaultBranch) {
    report.warnings.push(
      `The checkout is on ${branch}, but tasks start from and pull requests target ` +
        `${defaultBranch} (recorded as default_branch). To base tasks and pull requests on ` +
        `${branch} instead, add "--pr-target-branch ${branch}" to [defaults].worker_task_args ` +
        "in workspace.toml.",
    );
  }
}

/**
 * Readiness: the same checks as `devintern worker doctor`, before the service
 * step, so setup never installs a worker that will refuse to start. The
 * wizard prints them and derives its blockers; flags mode adds the tracker
 * credential probe and puts every check in the report.
 */
async function readinessStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") {
    run.report.checks = await runFlagsChecks(run);
    if (run.signInCheck) run.report.checks.push(run.signInCheck);
    return true;
  }
  let checks: ReadinessCheck[] | undefined;
  if (run.deps.collectReadiness) {
    run.log("\n📋 Readiness (the same checks as `devintern worker doctor`):");
    try {
      checks = await run.deps.collectReadiness(run.workspaceDir);
      const shown = withoutRepeatedHostFailures(checks, run.host);
      for (const line of renderReadinessReport(shown).lines) run.log(`   ${line}`);
    } catch (error) {
      run.log(`   ⚠️  Could not run the checks: ${(error as Error).message}`);
      run.log("   Run `devintern worker doctor` to check readiness.");
      checks = undefined;
    }
  }
  run.outcome.blockers = readinessBlockers(checks, run.outcome.licenseFailure).map((blocker) =>
    installAgentBlocker(blocker, checks, run),
  );
  return true;
}

/** The agent-CLI blocker names the install command the host step found. */
function installAgentBlocker(
  blocker: ReadinessBlocker,
  checks: ReadinessCheck[] | undefined,
  run: PromptRun,
): ReadinessBlocker {
  const install = run.host?.checks.installAgent;
  const harness = checks?.find((check) => check.id === "harness" && check.status === "fail");
  if (!install || !harness || !blocker.text.startsWith(`${harness.label}:`)) return blocker;
  const how = install.url ? `see ${install.url}` : `run ${install.command}`;
  return { ...blocker, text: `${harness.label}: install the agent CLI (${how})` };
}

function trackerDisplayName(tracker: string): string {
  return TRACKER_CAPABILITIES[tracker]?.displayName ?? tracker;
}

/** Probe the tracker credentials the way the wizard does. */
async function credentialCheck(
  plan: Plan,
  probe: NonNullable<NonInteractiveInitDeps["probe"]>,
  timeoutMs: number,
): Promise<InitCheck> {
  const name = trackerDisplayName(plan.tracker);
  const keys = trackerRequiredEnv(plan.tracker);
  const base = { name: "tracker-auth", label: "Tracker credential probe" } as const;
  if (plan.tracker === "markdown") {
    return { ...base, status: "skipped", message: "markdown tracker: no credentials to check" };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(plan.credentialEnv)) if (value) env[key] = value;
  try {
    await withTimeout(probe(plan.tracker, env), timeoutMs, `${name} credential check`);
    // Only name variables the probe actually exercised: without GITHUB_REPO
    // the GitHub check covers the token alone.
    const verified = keys.filter((key) => env[key] || key !== "GITHUB_REPO");
    return { ...base, status: "pass", message: `${name} accepted ${verified.join(", ")}` };
  } catch (error) {
    const message = errorMessage(error);
    // The HTTP status a tracker error names, for the credential-probe message.
    const status = /\b(401|403)\b/.exec(message)?.[1];
    return {
      ...base,
      status: "fail",
      message: status
        ? `${name} rejected the credentials (HTTP ${status}): ${message}`
        : `${name} credential check failed: ${message}`,
      hint: `Check ${keys.join(", ")} in the environment or --env-file`,
    };
  }
}

/** Flags mode: credential probe plus every `worker doctor` check, as report rows. */
async function runFlagsChecks(run: FlagsRun): Promise<InitCheck[]> {
  const { deps, workspaceDir } = run;
  const plan = run.plan!;
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const auth = await credentialCheck(plan, deps.probe ?? defaultProbe, timeoutMs);
  const authFailed = auth.status === "fail";
  // The credential probe above already ran; do not repeat it inside doctor.
  const doctorDeps: WorkerDoctorDeps = { probeCredentials: async () => {}, ...deps.doctor };
  // The license step already checked the entitlement; report its verdict.
  const entitlement = run.entitlement;
  if (entitlement) doctorDeps.checkEntitlement = () => entitlement;
  if (authFailed) {
    // The query cannot pass with rejected credentials; skip the API call.
    doctorDeps.dryRunQuery = () => Promise.reject(new Error("skipped"));
  }
  const readiness = await collectWorkerDoctorChecks(
    { workspacePath: workspaceConfigPath(workspaceDir) },
    { processEnv: deps.processEnv ?? process.env, probeTimeoutMs: timeoutMs, ...doctorDeps },
  );

  const checks: InitCheck[] = [auth];
  const label = authFailed ? undefined : await labelCheck(run, timeoutMs);
  if (label) checks.push(label);
  let labelsChecked = false;
  for (const check of readiness) {
    const mapped = toReportCheck(check);
    if (check.id === "query" && authFailed) {
      checks.push({
        ...mapped,
        status: "skipped",
        message: "not run: the tracker rejected the credentials",
        hint: undefined,
      });
      continue;
    }
    // The entitlement row has the same verdict as `worker doctor`: `action`
    // when nobody is signed in yet, `fail` for anything else.
    checks.push(mapped);
    // A dry run that ran (0 matches warns); once, for the workspace query.
    if (
      check.id === "query" &&
      (check.status === "ok" || check.status === "warn") &&
      !labelsChecked
    ) {
      labelsChecked = true;
      // The label row above already covers the devintern label.
      const labels = await queryLabelsCheck(plan, {
        labelOps: run.deps.devinternLabelOps ?? defaultDevinternLabelOps,
        timeoutMs,
        skip: label ? [DEVINTERN_LABEL] : [],
      });
      if (labels) checks.push(labels);
    }
  }
  return checks;
}

/**
 * Flags mode: the `devintern` label the default query selects. Checked when
 * the default query is in use or `--create-label` was given, and created
 * only with `--create-label`. A missing or uncreatable label warns: the
 * query still works, it just matches nothing until a ticket is labeled.
 *
 * @returns The report row, or undefined when there is nothing to check
 */
async function labelCheck(run: FlagsRun, timeoutMs: number): Promise<InitCheck | undefined> {
  const plan = run.plan!;
  const { createLabel } = run.args;
  if (!createLabel && !plan.taskQueryDefaulted) return undefined;
  const base = { name: "label", label: `${DEVINTERN_LABEL} label` } as const;
  const name = trackerDisplayName(plan.tracker);
  if (!supportsLabelCreation(plan.tracker)) {
    // Jira and Azure DevOps create a label (tag) the first time it is used.
    return createLabel
      ? {
          ...base,
          status: "skipped",
          message: `${name}: setup cannot create labels here; adding ${DEVINTERN_LABEL} to a ticket creates it`,
        }
      : undefined;
  }
  const ops = (run.deps.devinternLabelOps ?? defaultDevinternLabelOps)(
    plan.tracker,
    plan.credentialEnv,
  );
  if (!ops) return undefined;
  try {
    if (await withTimeout(ops.exists(), timeoutMs, `${name} label lookup`)) {
      return { ...base, status: "pass", message: `${name} has the ${DEVINTERN_LABEL} label` };
    }
    if (!createLabel) {
      return {
        ...base,
        status: "warn",
        message: `${name} has no ${DEVINTERN_LABEL} label yet, so the default query matches nothing`,
        hint: `Re-run with --create-label to create it, or create the ${DEVINTERN_LABEL} label in ${name}`,
      };
    }
    await withTimeout(ops.create(), timeoutMs, `${name} label creation`);
    run.report.labelCreated = true;
    run.log(`🏷️  Created the ${DEVINTERN_LABEL} label in ${name}`);
    return { ...base, status: "pass", message: `Created the ${DEVINTERN_LABEL} label in ${name}` };
  } catch (error) {
    return {
      ...base,
      status: "warn",
      message: `${name}: could not ${createLabel ? "create" : "look up"} the ${DEVINTERN_LABEL} label: ${condenseMessage(errorMessage(error))}`,
      hint: `Create the ${DEVINTERN_LABEL} label in ${name} (the token may lack permission to manage labels)`,
    };
  }
}

function applyEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }
  const env = parseEnvContent(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    // Match dotenv's normal precedence: an explicit shell value wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return env;
}

/** `owner/repo` of the checkout's GitHub `origin`, or null (no origin, not GitHub). */
async function originGitHubSlug(cwd: string): Promise<string | null> {
  const result = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
  const remote = result.success ? result.output.trim() : "";
  return remote ? gitHubSlugFromRemote(remote) : null;
}

export async function defaultEnsureTracker(
  cwd: string,
  prompt: PromptFn,
  promptSecret: PromptFn,
  log: LogFn,
): Promise<string | null> {
  // A legacy checkout `.env` is reused once; `add-repo` merges it into the
  // workspace env in the next step.
  const projectRoot = findProjectRoot({ startDir: cwd });
  const legacyEnvPath = resolve(projectRoot, ".devintern-code", ".env");
  if (existsSync(legacyEnvPath)) {
    const env = applyEnvFile(legacyEnvPath);
    return (env.TASK_TRACKER || process.env.TASK_TRACKER || "jira").toLowerCase();
  }

  // An existing workspace that already names a tracker needs no setup.
  const sharedEnvPath = workspaceEnvPath(resolveWorkspaceDir());
  const shared = applyEnvFile(sharedEnvPath);
  if (shared.TASK_TRACKER) return shared.TASK_TRACKER.toLowerCase();

  // `worker init --non-interactive` records the tracker in `[defaults].tracker`
  // (workspace.toml is the source of truth) and its credentials in the workspace
  // `.env`, without TASK_TRACKER. Treat that pair as configured.
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  const configured = existsSync(configPath) ? loadWorkspaceConfig(configPath).defaults.tracker : "";
  if (
    configured &&
    trackerRequiredEnv(configured).every((key) => shared[key] || process.env[key])
  ) {
    log(`   Using ${configured} from ${configPath}`);
    // The later steps (query dry run, readiness) build their client from this.
    process.env.TASK_TRACKER ??= configured.toLowerCase();
    return configured.toLowerCase();
  }

  // `devintern init` saved this checkout's tracker in its own env file
  // (`~/.devintern/env/<repo>.env`). The worker polls with the workspace
  // `.env`, so copy those settings there instead of asking for them again.
  const reused = await reuseCheckoutTrackerEnv(cwd, workspaceDir, sharedEnvPath, log);
  if (reused) return reused;

  log("   No tracker config yet — running that subset of `devintern init`.");
  const originSlug = await originGitHubSlug(cwd);
  const result = await runTrackerSetup(prompt, log, defaultProbe, cwd, {
    promptSecret,
    envLabel: sharedEnvPath,
    stepDefaults: originSlug ? { GITHUB_REPO: originSlug } : undefined,
    writeEnv: async (envContent) => {
      mergeIntoSharedEnv(sharedEnvPath, envContent, log);
      return sharedEnvPath;
    },
  });
  if (!result) {
    return null;
  }
  applyEnvFile(sharedEnvPath);
  return result.trackerId;
}

/**
 * Reuse the tracker settings `devintern init` saved for the checkout at `cwd`
 * (its `[[repos]]` entry's `env_file`): when they name a tracker and hold its
 * required keys, merge them into the workspace `.env` and apply them.
 *
 * @returns The tracker id, or null when the checkout has no usable settings
 */
async function reuseCheckoutTrackerEnv(
  cwd: string,
  workspaceDir: string,
  sharedEnvPath: string,
  log: LogFn,
): Promise<string | null> {
  let envFile: string | undefined;
  try {
    envFile = (await findWorkspaceRepoForCheckout({ cwd, workspaceDir }))?.repo.envFile;
  } catch {
    return null;
  }
  if (!envFile) return null;
  const envPath = resolve(workspaceDir, envFile);
  if (!existsSync(envPath)) return null;
  const content = readFileSync(envPath, "utf8");
  const env = parseEnvContent(content);
  const tracker = env.TASK_TRACKER?.toLowerCase();
  if (!tracker || !trackerRequiredEnv(tracker).every((key) => env[key])) return null;
  log(`   Using ${trackerDisplayName(tracker)} from ${envPath} (saved by \`devintern init\`).`);
  mergeIntoSharedEnv(sharedEnvPath, content, log);
  applyEnvFile(sharedEnvPath);
  return tracker;
}

/**
 * Merge wizard output into the workspace's shared `.env`: keys it lacks are
 * appended; keys it already has are kept (other repos rely on them) and a
 * differing value is reported instead of overwritten.
 */
function mergeIntoSharedEnv(envPath: string, envContent: string, log: LogFn): void {
  const incoming = parseEnvContent(envContent);
  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const existing = parseEnvContent(existingText);
  const additions: string[] = [];
  const differing: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in existing)) additions.push(`${key}=${value}`);
    else if (existing[key] !== value) differing.push(key);
  }
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  const separator = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
  writeSecretFile(
    envPath,
    existingText + separator + additions.map((line) => `${line}\n`).join(""),
  );
  log(`   Saved tracker settings to ${envPath}`);
  if (differing.length > 0) {
    log(
      `   ⚠️  Kept the existing values for: ${differing.join(", ")} (edit ${envPath} to change them).`,
    );
  }
}

/**
 * Turn a ready-tasks dry-run error into one readable line. A GitHub search
 * the token cannot run (the repository is missing or not granted to it) is a
 * credentials problem, flagged `access` so the wizard does not blame the query.
 *
 * @param message - The error message from the tracker client
 * @param githubRepo - Configured `GITHUB_REPO`, named in the access message
 */
export function describeQueryFailure(
  message: string,
  githubRepo?: string,
): { text: string; access: boolean } {
  const status = /GitHub API error \((\d{3})\)/.exec(message)?.[1];
  const repo = githubRepo || "the repository";
  if (
    status === "422" &&
    /cannot be searched|do not exist or you do not have permission/i.test(message)
  ) {
    return {
      text:
        `GitHub can't search ${repo}: the repository doesn't exist or the token can't see it. ` +
        "Check GITHUB_REPO and the token's repository access.",
      access: true,
    };
  }
  if (status === "401") {
    return {
      text: "GitHub rejected the token (401): it is mistyped, expired, or revoked.",
      access: true,
    };
  }
  // GitHub (and others) append the raw JSON body; keep only its messages.
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    const messages = [...message.slice(jsonStart).matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1])
      .filter((text): text is string => Boolean(text));
    if (messages.length > 0) {
      const prefix = message.slice(0, jsonStart).replace(/[\s:]+$/, "");
      return {
        text: condenseMessage(`${prefix}: ${[...new Set(messages)].join("; ")}`),
        access: false,
      };
    }
  }
  return { text: condenseMessage(message), access: false };
}

/**
 * What still keeps the worker from running, one line each: the failing
 * readiness checks when they ran, otherwise the license step's result.
 *
 * @param checks - `worker doctor` checks, or undefined when they did not run
 * @param licenseFailure - License step outcome (null when entitled)
 */
export function readinessBlockers(
  checks: ReadinessCheck[] | undefined,
  licenseFailure: string | null | undefined,
): ReadinessBlocker[] {
  if (checks) {
    return checks
      .filter((check) => check.status === "fail" || check.status === "action")
      .map((check) => ({
        text: `${check.label}: ${check.hint ?? check.detail ?? "see the check above"}`,
        action: check.status === "action",
      }));
  }
  if (licenseFailure) {
    return [
      {
        text: `Automation entitlement: run \`${signInCommand()}\` to begin your ${WORKER_PILOT_OFFER}, or set LICENSE_KEY in the workspace .env`,
        action: false,
      },
    ];
  }
  return [];
}
