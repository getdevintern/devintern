import { checkLicense } from "@devintern/license-check";
import {
  enforceLicenseOrExit,
  getLoadedEnvPath,
  loadEnvironment,
  loadSupabaseConfig,
} from "../cli/bootstrap";
import { flushAnalytics, trackDoctorRun } from "./analytics";

/**
 * `devintern dashboard` — serve the local observability dashboard standalone.
 * Reads the worker's SQLite read-only, so it works with or without the worker.
 */
export async function runDashboardCommand(args: string[]): Promise<void> {
  loadEnvironment();

  let port: number | undefined;
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[i + 1];
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
      console.log("  -h, --help     Display this help message");
      process.exit(0);
    }
  }

  // Same entitlement as the worker: the dashboard is part of the automation tier.
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(),
    requireAutomation: true,
  });
  await enforceLicenseOrExit(licenseResult);

  const { startDashboardServer } = await import("../../dashboard-server");
  const server = startDashboardServer({ port, host });

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
