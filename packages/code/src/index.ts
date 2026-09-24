#!/usr/bin/env node

import { dirname } from "path";
import { fileURLToPath } from "url";
import { checkLicense } from "@devintern/license-check";
import { resolveHarness, resolveExecutablePathStrict } from "@devintern/agent-harness";
import type { ResolvedHarness } from "@devintern/agent-harness";
import { isMarkdownFilePath } from "@devintern/task-trackers";
import { captureError, flushErrorTracking } from "@devintern/utils";
import { setSandboxOverride } from "./lib/agent/sandbox";
import { initSentryOnce } from "./lib/observability/sentry-init";
import { flushAnalytics, isAnonymousIdNewlyCreated, track } from "./lib/observability/analytics";
import type { AnalyticsPropValue } from "./lib/observability/analytics";
import { resolveAutoReviewIterations } from "./lib/review/auto-review-config";
import { TaskFormatter } from "./lib/task/formatter";
import { ensureTrackerEnvConfigured } from "./lib/init/first-run";
import { TaskTrackerManager } from "./lib/trackers/manager";
import type { TaskTrackerClient } from "./lib/trackers/client";
import { JiraTaskTrackerClient } from "./lib/trackers/jira/jira-task-tracker-client";
import {
  supportsEstimate,
  supportsQuery,
  trackersSupportingEstimate,
  trackersSupportingQuery,
} from "./lib/trackers/capabilities";
import { LockManager } from "./lib/lock-manager";
import { Utils } from "./lib/utils";
import { isAutomatedEnvironment } from "./lib/config/env-detector";
import {
  VERSION,
  checkForCliUpdate,
  enforceLicenseOrExit,
  getLoadedEnvPath,
  loadEnvironment,
  loadSupabaseConfig,
  migrateLegacyConfigDir,
  setEnvironmentEntryDir,
} from "./lib/cli/bootstrap";
import { isSubcommandCommand, createProgram } from "./lib/cli/program";
import type { ProgramOptions } from "./lib/cli/program";
import { validateEnvironment } from "./lib/config/validate-environment";
import { isWorkerTaskProcess, runContext } from "./lib/cli/context";
import { runEstimationBatch, resolveRunTargets, runTaskBatch } from "./lib/cli/run";
import { processSingleTask } from "./lib/task/pipeline";
import { reportProcessingFailure } from "./lib/task/processing-failure";
import { runInitCommand } from "./lib/init/cli";
import { runWorkerCli } from "./lib/worker/cli";
import { runDashboardCommand, runDoctorCommand } from "./lib/observability/cli";
import { runWebhookCommand } from "./lib/code-host/cli";
import { runAddressReviewCommand, runResolveConflictsCommand } from "./lib/review/cli";
import { runLoginCommand, runLogoutCommand, runWhoamiCommand } from "./lib/account/cli";
import { runSandboxCommand } from "./lib/agent/cli";

// Get the directory of this script at runtime (works in both ESM and bundled environments)
const __filename_resolved = fileURLToPath(import.meta.url);
const __dirname_resolved = dirname(__filename_resolved);
setEnvironmentEntryDir(__dirname_resolved);

const KNOWN_SANDBOX_PROVIDERS = new Set([
  "none",
  "auto",
  "native",
  "nono",
  "srt",
  "docker",
  "smolvm",
]);

/** Allowlisted, non-identifying props for the `cli_run` analytics event. */
function buildCliRunProps(tracker: string): Record<string, AnalyticsPropValue | undefined> {
  const sandboxProvider = options.sandbox ?? process.env.AGENT_SANDBOX;
  return {
    cli_version: VERSION,
    os: process.platform,
    arch: process.arch,
    ci: isAutomatedEnvironment(),
    tracker,
    run_mode: options.estimate ? "estimate" : options.query ? "query" : "tasks",
    task_count: options.query ? undefined : taskKeys.length,
    create_pr: options.createPr === true,
    auto_review: options.autoReview === true,
    estimate: options.estimate === true,
    sandbox: KNOWN_SANDBOX_PROVIDERS.has(sandboxProvider ?? "") ? sandboxProvider : undefined,
  };
}

// Sentry error tracking — uses the baked-in DevIntern DSN unless SENTRY_DISABLED=1.
// Shared entry-point init (worker/webhook standalone reuse this too); call sites
// pass the release so standalone entries stay attributed to the CLI version.

// Migrate legacy config directory on startup
migrateLegacyConfigDir();

// Check npm for a newer global install before any real work. Local/monorepo
// runs and --help/--version/--no-update are no-ops inside maybeOfferCliUpdate.
await checkForCliUpdate();

// Check if running subcommands before parsing
// This needs to happen early to avoid Commander treating them as task keys
if (process.argv[2] === "init") {
  await runInitCommand();
} else if (process.argv[2] === "worker") {
  // Handle worker command - long-running workspace daemon.
  await runWorkerCli(process.argv.slice(3));
} else if (process.argv[2] === "workspace") {
  console.error("❌ Unknown command: workspace");
  console.error("   Workspace setup and management live under `devintern worker`.");
  console.error("   Run `devintern worker --help` for available commands.");
  process.exit(1);
} else if (process.argv[2] === "dashboard") {
  await runDashboardCommand(process.argv.slice(3));
} else if (process.argv[2] === "webhook") {
  await runWebhookCommand(process.argv.slice(3));
} else if (process.argv[2] === "address-review") {
  await runAddressReviewCommand(process.argv.slice(3));
} else if (process.argv[2] === "resolve-conflicts") {
  await runResolveConflictsCommand(process.argv.slice(3));
} else if (process.argv[2] === "login") {
  await runLoginCommand(process.argv);
} else if (process.argv[2] === "logout") {
  await runLogoutCommand();
} else if (process.argv[2] === "sandbox") {
  await runSandboxCommand();
} else if (process.argv[2] === "doctor") {
  await runDoctorCommand();
} else if (process.argv[2] === "whoami") {
  await runWhoamiCommand();
} else {
  // Load environment variables early (before CLI parsing)
  loadEnvironment();
}

/**
 * Resolve the configured agent harness and normalize its executable path.
 *
 * @param providedPath - Optional CLI path override from flags
 */
function resolveAgentHarness(providedPath?: string): ResolvedHarness {
  const harness = resolveHarness({ cliPath: providedPath });
  harness.path = resolveExecutablePathStrict(harness.path, harness.harness.displayName);
  return harness;
}

// Configure CLI
const program = createProgram();

// Only parse with Commander if we're not running a subcommand
const isSubcommand = isSubcommandCommand(process.argv[2]);
if (!isSubcommand) {
  program.parse();
}

const options = isSubcommand ? ({} as ProgramOptions) : program.opts<ProgramOptions>();
const taskKeys = isSubcommand ? [] : program.args;

runContext.options = options;

if (options.sandbox) {
  setSandboxOverride(options.sandbox);
}

// Map deprecated options to their canonical equivalents
if (options.jql && !options.query) {
  process.stderr.write("⚠️  --jql is deprecated, use --query instead\n");
  options.query = options.jql;
}
if (options.skipJiraComments && !options.skipComments) {
  process.stderr.write("⚠️  --skip-jira-comments is deprecated, use --skip-comments instead\n");
  options.skipComments = true;
}

// Reload environment variables if custom env file was specified
if (options.envFile) {
  loadEnvironment(options.envFile);
} else if (options.verbose) {
  const envPath = getLoadedEnvPath();
  if (envPath) {
    console.log(`📁 Loaded environment from: ${envPath}`);
  } else {
    console.log("⚠️  No .env file found in standard locations");
    console.log("   Searched upward from current directory, then home and package directories.");
  }
}

// Resolve the unified auto-review iteration cap up front so an invalid
// --auto-review-iterations value or AUTO_REVIEW_ITERATIONS env var fails fast
// with a clear error instead of starting agent runs the loop would then
// abort. When auto-review is off the cap is unused and the env var is ignored.
runContext.autoReviewIterationCap = (() => {
  if (options.autoReviewIterations === undefined && !options.autoReview) {
    return undefined;
  }
  try {
    return resolveAutoReviewIterations(options.autoReviewIterations);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }
})();

// Resolve the final agent harness
const resolvedAgent = resolveAgentHarness(options.agentPath || options.claudePath);
runContext.resolvedAgent = resolvedAgent;
if (options.verbose) {
  console.log(`🤖 ${resolvedAgent.harness.displayName} resolved to: ${resolvedAgent.path}`);
}

/** CLI entry: parse args, acquire lock, and process task key(s) or JQL results. */
async function main(): Promise<void> {
  try {
    initSentryOnce(`code@${VERSION}`);

    // Acquire lock to prevent multiple instances
    runContext.lockManager = new LockManager();
    const lockResult = runContext.lockManager.acquire();

    if (!lockResult.success) {
      console.error(`❌ ${lockResult.message}`);
      console.error("   Please wait for the other instance to complete or stop it manually.");
      if (lockResult.pid) {
        console.error(`   You can stop the other instance with: kill ${lockResult.pid}`);
      }
      process.exit(1);
    }

    // Check for flags that require specific tracker support before env validation
    const activeTrackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
    if (options.query && !supportsQuery(activeTrackerType)) {
      console.error(
        `❌ Error: --query is not supported for the '${activeTrackerType}' task tracker. ` +
          `Trackers with query support: ${trackersSupportingQuery().join(", ")}.`,
      );
      process.exit(1);
    }
    if (options.estimate && !supportsEstimate(activeTrackerType)) {
      console.error(
        `❌ Error: --estimate is not supported for the '${activeTrackerType}' task tracker. ` +
          `Trackers with estimation support: ${trackersSupportingEstimate().join(", ")}.`,
      );
      process.exit(1);
    }

    // Anonymous usage analytics (PostHog). Fire-and-forget; never blocks or
    // fails the run. Opt out via DEVINTERN_TELEMETRY_DISABLED=1 or
    // analytics.enabled: false in .devintern-code/settings.json.
    if (!isWorkerTaskProcess()) {
      const firstTelemetryRun = isAnonymousIdNewlyCreated();
      void track("cli_run", buildCliRunProps(activeTrackerType));
      if (firstTelemetryRun && !isAutomatedEnvironment()) {
        console.log(
          "ℹ️  devintern collects anonymous usage stats (never task content, code, or credentials)." +
            "\n   Disable with DEVINTERN_TELEMETRY_DISABLED=1 — see https://devintern.com/privacy/",
        );
      }
    }

    // Validate environment — skip when every argument is a local markdown file path
    // (those tasks need no PM credentials). With missing credentials in an
    // interactive terminal, offer the setup wizard inline before failing.
    const needsTrackerEnv = options.query || taskKeys.some((k) => !isMarkdownFilePath(k));
    if (needsTrackerEnv) {
      const firstRun = await ensureTrackerEnvConfigured({
        automated: isAutomatedEnvironment(),
        reloadEnv: () => {
          loadEnvironment(options.envFile);
        },
      });
      if (firstRun === "failed") {
        await validateEnvironment();
      }
    }

    // License check — interactive use is free under FSL; only unattended
    // execution (systemd, cron, CI) requires an automation license.
    if (isAutomatedEnvironment()) {
      const supabaseConfig = loadSupabaseConfig();
      const licenseResult = await checkLicense({
        productKey: "devintern/code",
        supabaseConfig,
        requireAutomation: true,
      });
      await enforceLicenseOrExit(licenseResult);
    }

    // Pull latest changes from remote (unless git is disabled)
    if (options.git) {
      const prTargetBranchSource = program.getOptionValueSource("prTargetBranch");
      options.prTargetBranchExplicit = prTargetBranchSource !== "default";
      options.requestedPrTargetBranch = options.prTargetBranchExplicit
        ? options.prTargetBranch
        : undefined;
      if (prTargetBranchSource === "default") {
        options.prTargetBranch = await Utils.getMainBranchName();
        console.log(`   Default branch detected as '${options.prTargetBranch}'`);
      } else {
        const requestedBranch = options.prTargetBranch;
        options.prTargetBranch = await Utils.resolveDefaultBranch(requestedBranch);
        if (options.prTargetBranch !== requestedBranch) {
          console.log(
            `⚠️  Target branch '${requestedBranch}' not found on remote, falling back to '${options.prTargetBranch}'`,
          );
        }
      }

      console.log("\n📥 Pulling latest changes from remote...");
      const pullResult = await Utils.pullLatestChanges(options.prTargetBranch, {
        verbose: options.verbose,
      });

      if (pullResult.success) {
        console.log(`✅ ${pullResult.message}`);
      } else {
        // Don't fail the entire workflow if pull fails - just warn the user
        console.log(`⚠️  ${pullResult.message}`);
        console.log("   Continuing without pulling latest changes...");
        console.log("   You may want to pull manually before processing tasks.\n");
      }
    }

    const tasksToProcess = await resolveRunTargets(taskKeys, activeTrackerType);
    if (!tasksToProcess) return;

    // Estimation mode: separate code path
    if (options.estimate) {
      await runEstimationBatch({ activeTrackerType, tasksToProcess });
      return;
    }

    // Process tasks sequentially
    await runTaskBatch({
      activeTrackerType,
      tasksToProcess,
      runTask: processSingleTask,
    });
  } catch (error) {
    const err = error as Error;
    console.error(`❌ Error: ${err.message}`);
    if (options.verbose && err.stack) {
      console.error(err.stack);
    }
    // Setup/query failures that reach here were not captured by the per-task
    // handlers (lock, tracker query, license, ...).
    captureError(error, { stage: "main" });
    // Release lock before exiting on error
    if (runContext.lockManager) {
      runContext.lockManager.release();
    }
    await flushAnalytics();
    await flushErrorTracking();
    process.exit(1);
  }
}

// Handle uncaught errors
process.on("unhandledRejection", (error: Error) => {
  console.error("❌ Unhandled error:", error.message);
  if (options.verbose && error.stack) {
    console.error(error.stack);
  }
  captureError(error);
  // Release lock before exiting
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  void Promise.all([flushErrorTracking(), flushAnalytics()]).finally(() => process.exit(1));
});

// Handle process termination signals
let shuttingDown = false;

async function gracefulShutdown(signal: "SIGINT" | "SIGTERM", exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n\n⚠️  Received ${signal}, cleaning up...`);
  // If a task is mid-flight, tell the tracker it was interrupted instead of
  // leaving it silently in "In Progress" with no PR and no feedback.
  const context = runContext.activeTaskContext;
  if (context) {
    // Bound the feedback attempt so tracker I/O can never stall shutdown.
    const shutdownTimer = setTimeout(() => process.exit(exitCode), 15_000);
    try {
      await reportProcessingFailure(
        context.taskKey,
        `Processing was interrupted (${signal}) before a pull request could be created`,
      );
    } catch {
      /* best-effort: never block shutdown on tracker I/O */
    }
    clearTimeout(shutdownTimer);
  }
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  // Bounded; pending crash/handled-error and queued analytics events get a
  // chance to send before the process is torn down.
  await flushAnalytics();
  await flushErrorTracking();
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT", 130); // Standard exit code for SIGINT
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM", 143); // Standard exit code for SIGTERM
});

// Handle uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  console.error("❌ Uncaught exception:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  captureError(error);
  // Release lock before exiting
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  void Promise.all([flushErrorTracking(), flushAnalytics()]).finally(() => process.exit(1));
});

// Run the main function (only if not running a subcommand)
if (require.main === module && !isSubcommand) {
  main();
}

export {
  main,
  JiraTaskTrackerClient,
  JiraTaskTrackerClient as JiraClient,
  TaskFormatter,
  TaskTrackerManager,
};
export type { TaskTrackerClient };
