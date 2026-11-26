/**
 * Human-readable lines for the worker service's start check and status,
 * shared by `devintern worker service` and the `worker init` wizard so both
 * say the same, honest thing.
 */

import { loadWorkspaceConfig } from "../workspace/config";
import { workspaceConfigPath } from "../workspace/paths";
import { serviceLogCommand } from "./service-control";
import type { ServiceRunState, StartCheck, WorkerServiceStatus } from "./service-control";

/** Command that (re)starts the installed service. */
export const SERVICE_RESTART_COMMAND = "devintern worker service restart";

/** Dashboard address for this workspace, or null when the dashboard is off. */
export function dashboardUrlFor(workspaceDir: string): string | null {
  try {
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    if (!config.workspace.dashboard) return null;
    return `http://localhost:${config.workspace.dashboardPort}`;
  } catch {
    return "http://localhost:4400";
  }
}

/** Lines describing a start check; the first line carries the verdict icon. */
export function renderStartCheck(
  check: StartCheck,
  context: { platform: NodeJS.Platform; workspaceDir: string },
): string[] {
  if (check.state === "running") {
    const dashboard = dashboardUrlFor(context.workspaceDir);
    return [
      `✅ The worker is running${check.pid === undefined ? "" : ` (pid ${check.pid})`}.`,
      ...(dashboard ? [`   Dashboard: ${dashboard}`] : []),
    ];
  }
  if (check.state === "starting") {
    return [
      `⏳ The service is up, but the worker has not finished starting after ${Math.round(check.waitedMs / 1000)}s.`,
      "   Check again with `devintern worker service status`; recent output: `devintern worker logs`.",
    ];
  }
  const lines = [`❌ The worker did not start: ${check.reason}`];
  const logLines = check.logLines.filter((line) => line.trim());
  if (logLines.length > 0) {
    lines.push("   Last worker log lines:");
    for (const line of logLines) lines.push(`     ${line.trim()}`);
  }
  lines.push(
    check.permanent
      ? `   The service will not retry on its own. Fix the problem above, then run: ${SERVICE_RESTART_COMMAND}`
      : `   The service manager keeps retrying. Full log: ${serviceLogCommand(context.platform, context.workspaceDir)}`,
  );
  return lines;
}

const STATE_TEXT: Record<ServiceRunState, string> = {
  running: "running",
  starting: "starting (the worker has not finished starting yet)",
  restarting: "restarting (the worker exited; the service manager will retry it)",
  failed: "failed (the service gave up; fix the problem, then restart it)",
  stopped: "stopped",
  not_installed: "not installed",
  unavailable: "unavailable",
};

/** Lines for `devintern worker service status`. */
export function renderServiceStatus(status: WorkerServiceStatus, workspaceDir: string): string[] {
  const lines = [`Service:    ${STATE_TEXT[status.state]}`];
  if (status.state === "unavailable") {
    lines.push(`            ${status.reason ?? "no service manager"}`);
    lines.push("            Run the worker in the foreground instead: `devintern worker`.");
    return lines;
  }
  if (!status.installed) {
    lines.push("            Install it with: devintern worker service install");
    return lines;
  }
  lines.push(
    `Definition: ${status.definitionPath}${status.managed ? "" : " (custom, not managed by DevIntern)"}`,
  );
  if (status.platform === "linux") {
    const m = status.manager;
    const parts = [
      m.activeState && `${m.activeState}${m.subState ? ` (${m.subState})` : ""}`,
      m.execMainStatus !== undefined && `last exit status ${m.execMainStatus}`,
      m.restarts !== undefined && `${m.restarts} restart(s)`,
      `${status.enabled ? "enabled" : "disabled"} at boot`,
    ].filter(Boolean);
    lines.push(`systemd:    ${parts.join(", ")}`);
  } else if (status.platform === "darwin") {
    const m = status.manager;
    lines.push(
      `launchd:    ${m.loaded ? `loaded${m.activeState ? `, ${m.activeState}` : ""}${m.lastExitCode !== undefined ? `, last exit code ${m.lastExitCode}` : ""}` : "not loaded"}`,
    );
  }
  const worker = status.worker;
  lines.push(
    `Worker:     ${worker.status}${worker.pid !== undefined && worker.status === "running" ? ` (pid ${worker.pid})` : ""}`,
  );
  const exit = status.lastExit;
  if (exit && status.state !== "running") {
    if (exit.state === "startup_failed") {
      lines.push(`Last start: failed at ${exit.at} (exit ${exit.exitCode ?? "?"})`);
      for (const line of (exit.message ?? "").split("\n").filter((text) => text.trim())) {
        lines.push(`            ${line.trim()}`);
      }
    } else if (exit.state === "stopped") {
      lines.push(`Last stop:  clean stop at ${exit.at}`);
    }
  }
  if (status.state === "failed" || status.state === "restarting") {
    lines.push("", `Fix the problem above, then run: ${SERVICE_RESTART_COMMAND}`);
    lines.push(`Full log: ${serviceLogCommand(status.platform, workspaceDir)}`);
  }
  return lines;
}
