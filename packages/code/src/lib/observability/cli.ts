import { checkLicense } from "@devintern/license-check";
import { dirname, resolve } from "path";
import { enforceLicenseOrExit, loadEnvironment, loadSupabaseConfig } from "../cli/bootstrap";
import { bootstrapCheckoutEnv, checkoutEnvPath } from "../cli/checkout-env";
import { hasHelpArg } from "../cli/help";
import { flushAnalytics, trackDoctorRun } from "./analytics";
import type { runWorkerDoctorText } from "./worker-doctor-text";

/**
 * `devintern dashboard` — serve the local observability dashboard standalone.
 * Reads the worker's SQLite read-only, so it works with or without the worker.
 */
export async function runDashboardCommand(args: string[]): Promise<void> {
  loadEnvironment();

  let port: number | undefined;
  let host: string | undefined;
  let workspacePath: string | undefined;
  const allowOriginArgs: string[] = [];
  let tailscaleAutodetect = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-origin") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error("❌ --allow-origin requires an origin, e.g. https://box.tailnet.ts.net.");
        process.exit(1);
      }
      allowOriginArgs.push(args[i + 1]);
      i++;
    } else if (args[i] === "--no-tailscale-autodetect") {
      tailscaleAutodetect = false;
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i] === "--workspace") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error("❌ --workspace requires a path to workspace.toml.");
        process.exit(1);
      }
      workspacePath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: devintern dashboard [options]");
      console.log("");
      console.log("Serve the local observability dashboard: run history, per-run stage");
      console.log("timelines, and aggregate stats, read from the worker's local database.");
      console.log("Works with the worker running or stopped; data never leaves this machine.");
      console.log("");
      console.log("Options:");
      console.log("  --port <port>  Port to listen on (default: 4400 or DASHBOARD_PORT)");
      console.log("  --host <host>  Loopback host to bind to (default: 127.0.0.1;");
      console.log("                 accepted: 127.0.0.1, localhost, ::1)");
      console.log("  --workspace <path>  Read queue counts, worker liveness, and run");
      console.log("                      transcripts from this workspace.toml (or its");
      console.log("                      workspace directory).");
      console.log("                      (default: ~/.devintern/, or DEVINTERN_WORKSPACE_DIR)");
      console.log("  --allow-origin <origin>  Also trust this non-loopback origin, e.g. a");
      console.log("                      reverse proxy (https://dash.example.internal).");
      console.log("                      Repeatable; also DASHBOARD_ALLOWED_ORIGINS.");
      console.log("  --no-tailscale-autodetect  Do not trust names `tailscale serve`");
      console.log("                      proxies to this dashboard (also");
      console.log("                      DASHBOARD_TAILSCALE_AUTODETECT=0).");
      console.log("  -h, --help     Display this help message");
      process.exit(0);
    }
  }

  const { parseDashboardAllowedOriginList, mergeDashboardAllowedOrigins } =
    await import("./dashboard-origins");
  const flagOrigins = parseDashboardAllowedOriginList(allowOriginArgs, "--allow-origin");
  if (flagOrigins.errors.length > 0) {
    for (const error of flagOrigins.errors) console.error(`❌ ${error}`);
    process.exit(1);
  }
  let allowedOrigins = flagOrigins.origins;

  let workspaceDir: string | undefined;
  if (workspacePath) {
    const { resolveWorkspaceArgPath } = await import("./dashboard-db");
    const configPath = resolveWorkspaceArgPath(workspacePath);
    if (!configPath) {
      console.error(`❌ No workspace.toml at ${resolve(workspacePath)}.`);
      console.error("   Pass an existing workspace.toml or the directory that contains it.");
      process.exit(1);
    }
    workspaceDir = dirname(configPath);
    // The workspace's [dashboard] access settings apply to the standalone
    // dashboard too, so it is reachable the same way as the worker's.
    try {
      const { loadWorkspaceConfig } = await import("../workspace/config");
      const { dashboard } = loadWorkspaceConfig(configPath);
      allowedOrigins = mergeDashboardAllowedOrigins(allowedOrigins, dashboard.allowedOrigins);
      tailscaleAutodetect &&= dashboard.tailscaleAutodetect;
    } catch (error) {
      console.warn(
        `⚠️  Ignoring [dashboard] settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Same entitlement as the worker: the dashboard is part of the automation tier.
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(),
    requireAutomation: true,
    allowTrial: true,
  });
  if (licenseResult.trialAvailable) {
    licenseResult.valid = false;
    licenseResult.source = "none";
    licenseResult.message = "Start `devintern worker` once to activate the free Worker Pilot.";
  }
  await enforceLicenseOrExit(licenseResult);

  const { resolveDashboardQueueDbPath } = await import("./dashboard-db");
  const { startDashboardServer } = await import("../../dashboard-server");
  // A custom workspace redirects the durable queue counts, worker liveness,
  // and harness transcripts; run history keeps reading the project-scoped DB
  // unless WEBHOOK_QUEUE_DB pins one.
  const queueDbPath = workspaceDir ? resolveDashboardQueueDbPath(workspaceDir) : undefined;
  // Automations live only in workspace.toml: list the explicit workspace's
  // [[automations]] (read-only), else the default workspace's when one exists.
  const { hasWorkspace, resolveWorkspaceDir } = await import("../workspace/paths");
  const automationWorkspaceDir =
    workspaceDir ?? (hasWorkspace(resolveWorkspaceDir()) ? resolveWorkspaceDir() : undefined);
  const automationActions = automationWorkspaceDir
    ? (await import("../automation/workspace-dashboard")).loadWorkspaceAutomationActions(
        automationWorkspaceDir,
      )
    : undefined;
  const { warnIgnoredProjectAutomations } = await import("../automation/config");
  warnIgnoredProjectAutomations();
  // Prime the job-memory probe before the first `--force` retry can spawn: the
  // spawn path never blocks, so without this the first retry runs uncapped.
  // `spawnCliForceRetry` resolves the same `process.env`.
  const { describeJobMemoryPlan, resolveJobMemoryPlanForStartup } =
    await import("../worker/job-memory");
  console.log(`🧠 ${describeJobMemoryPlan(await resolveJobMemoryPlanForStartup(process.env))}`);
  let server: ReturnType<typeof startDashboardServer>;
  try {
    server = startDashboardServer({
      port,
      host,
      queueDbPath,
      workspaceDir,
      automationActions,
      allowedOrigins,
      tailscaleAutodetect,
    });
  } catch (error) {
    // Non-loopback --host, malformed DASHBOARD_ALLOWED_ORIGINS, busy port.
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const shutdown = (): void => {
    console.log("\n👋 Dashboard stopped");
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * `devintern doctor` — readiness check for a first successful run.
 *
 * Exit codes: 0 ready (warnings, e.g. a degraded harness chain, are printed
 * but do not fail); 1 not ready (any check failed, including a harness chain
 * with no usable entry); 2 degraded, only with `--strict` (warnings present,
 * no failures) so CI can gate on a fully ready setup.
 */
export async function runDoctorCommand(): Promise<never> {
  const args = process.argv.slice(2);
  if (hasHelpArg(args)) {
    console.log(
      [
        "Usage: devintern doctor [--strict]",
        "",
        "Check runtime, git, every agent harness chain entry (executable, effective",
        "sandbox, model, readiness), tracker credentials, sign-in, and license",
        "readiness for a first run.",
        "",
        "In a checkout registered as a worker repository, runs the worker checks",
        "instead (the same checklist as `devintern worker doctor`).",
        "",
        "Exit codes:",
        "  0  ready (warnings such as a degraded harness chain are shown, not fatal)",
        "  1  not ready: at least one check failed",
        "  2  degraded: warnings but no failures (only with --strict); in a worker",
        "     repository also when only a step for you is left (sign in)",
        "",
        "Options:",
        "  --strict    Exit 2 when any check warns",
        "  -h, --help  Display this help message",
      ].join("\n"),
    );
    process.exit(0);
  }
  const strict = args.includes("--strict");
  const workerCode = await runWorkerRepoDoctor(strict);
  if (workerCode !== null) {
    await flushAnalytics();
    process.exit(workerCode);
  }
  const { collectReadinessChecks, renderReadinessReport } = await import("./readiness");
  // A registered checkout reads the workspace env layers, like a task run.
  const workspaceRun = await bootstrapCheckoutEnv();
  let supabaseConfig;
  try {
    supabaseConfig = loadSupabaseConfig();
  } catch {
    supabaseConfig = undefined;
  }
  const checks = await collectReadinessChecks({
    envPath: checkoutEnvPath(workspaceRun),
    supabaseConfig,
  });
  console.log("🩺 devintern readiness:\n");
  const report = renderReadinessReport(checks);
  console.log(report.lines.join("\n"));
  const { hasWorkspace, workspaceConfigPath } = await import("../workspace/paths");
  if (hasWorkspace()) {
    console.log(
      `ℹ️  Worker workspace found (${workspaceConfigPath()}) — run \`devintern worker doctor\` to check unattended readiness.`,
    );
  }
  if (report.hasFailures) {
    console.log("\n❌ Not ready — fix the failed checks above.");
  } else if (report.hasWarnings) {
    console.log("\n⚠️  Ready but degraded — review the warnings above.");
  } else {
    console.log("\n✅ Everything looks good — run 'devintern <TASK-KEY>' to start.");
  }
  await trackDoctorRun({
    checks,
    hasFailures: report.hasFailures,
    hasWarnings: report.hasWarnings,
  });
  await flushAnalytics();
  process.exit(doctorExitCode(report, strict));
}

/**
 * `devintern doctor` in a worker repository: the checkout's `origin` (or
 * path) matches a `[[repos]]` entry that is not `manual_only`. Its tasks run
 * through the worker, so the per-repo checks would test the wrong thing; run
 * the `worker doctor` checklist instead.
 *
 * @returns The exit code, or null when this is not a worker repository
 */
export async function runWorkerRepoDoctor(
  strict: boolean,
  deps: {
    cwd?: string;
    workspaceDir?: string;
    log?: (message: string) => void;
    /** Worker checklist; defaults to the `worker doctor` text pass. */
    runChecks?: typeof runWorkerDoctorText;
  } = {},
): Promise<number | null> {
  const log = deps.log ?? console.log;
  const { findWorkspaceRepoForCheckout } = await import("../workspace/manual-run");
  const run = await findWorkspaceRepoForCheckout({
    cwd: deps.cwd,
    workspaceDir: deps.workspaceDir,
    // The route only reads the workspace; it composes no environment, so the
    // worker-subprocess marker (which guards env composition) does not apply.
    ignoreWorkerSubprocess: true,
  });
  if (!run || run.repo.manualOnly) return null;
  const { workspaceConfigPath } = await import("../workspace/paths");
  const configPath = workspaceConfigPath(run.workspaceDir);
  log(`ℹ️  This checkout is the worker repository "${run.repo.name}" in ${configPath}.`);
  log("   Running the worker checks (same as `devintern worker doctor`).\n");
  const runChecks = deps.runChecks ?? (await import("./worker-doctor-text")).runWorkerDoctorText;
  const result = await runChecks(run.workspaceDir, { workspacePath: configPath }, log);
  await trackDoctorRun({
    checks: result.checks,
    hasFailures: result.hasFailures,
    hasWarnings: result.hasWarnings,
  });
  if (result.exitCode !== 0) return result.exitCode;
  return strict && result.hasWarnings ? 2 : 0;
}

/**
 * Exit code for `devintern doctor` (see {@link runDoctorCommand}).
 *
 * @param report - Aggregate flags from `renderReadinessReport`.
 * @param strict - Whether `--strict` was passed.
 * @returns 1 on failures, 2 on warnings under `--strict`, otherwise 0.
 */
export function doctorExitCode(
  report: { hasFailures: boolean; hasWarnings: boolean },
  strict = false,
): number {
  if (report.hasFailures) return 1;
  if (strict && report.hasWarnings) return 2;
  return 0;
}
