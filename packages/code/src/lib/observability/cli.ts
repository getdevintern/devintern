import { checkLicense } from "@devintern/license-check";
import { dirname, resolve } from "path";
import {
  enforceLicenseOrExit,
  getLoadedEnvPath,
  loadEnvironment,
  loadSupabaseConfig,
} from "../cli/bootstrap";
import { hasHelpArg } from "../cli/help";
import { flushAnalytics, trackDoctorRun } from "./analytics";

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
  // With an explicit workspace, list its [[automations]] (read-only) instead of
  // the project-scoped automations.toml of whatever directory this started in.
  const automationActions = workspaceDir
    ? (await import("../automation/workspace-dashboard")).loadWorkspaceAutomationActions(
        workspaceDir,
      )
    : undefined;
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
 * `devintern doctor` — readiness check for a first successful run. Exits 1 when
 * any check fails so scripts and CI can gate on it.
 */
export async function runDoctorCommand(): Promise<never> {
  if (hasHelpArg(process.argv.slice(2))) {
    console.log(
      [
        "Usage: devintern doctor",
        "",
        "Check runtime, git, agent CLI, tracker credentials, sign-in, and license",
        "readiness for a first run. Exits non-zero when any check fails.",
        "",
        "Options:",
        "  -h, --help  Display this help message",
      ].join("\n"),
    );
    process.exit(0);
  }
  const { collectReadinessChecks, renderReadinessReport } = await import("./readiness");
  loadEnvironment();
  let supabaseConfig;
  try {
    supabaseConfig = loadSupabaseConfig();
  } catch {
    supabaseConfig = undefined;
  }
  const checks = await collectReadinessChecks({ envPath: getLoadedEnvPath(), supabaseConfig });
  console.log("🩺 devintern readiness:\n");
  const report = renderReadinessReport(checks);
  console.log(report.lines.join("\n"));
  if (report.hasFailures) {
    console.log("\n❌ Not ready — fix the failed checks above.");
  } else if (report.hasWarnings) {
    console.log("\n✅ Ready to run (with the warnings above).");
  } else {
    console.log("\n✅ Everything looks good — run 'devintern <TASK-KEY>' to start.");
  }
  await trackDoctorRun({
    checks,
    hasFailures: report.hasFailures,
    hasWarnings: report.hasWarnings,
  });
  await flushAnalytics();
  process.exit(report.hasFailures ? 1 : 0);
}
