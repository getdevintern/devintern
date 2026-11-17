/**
 * Serve the dashboard against a seeded demo workspace (see `seed.ts`).
 *
 * Writes a worker lock for this process so the status strip reads
 * "worker running", then starts the real dashboard server on loopback.
 *
 * Usage: DEVINTERN_WORKSPACE_DIR=<dir> bun run scripts/demo/serve.ts <workspace-dir> <port>
 */

import { utimesSync, writeFileSync } from "fs";
import { join } from "path";

import { loadWorkspaceAutomationActions } from "../../../code/src/lib/automation/workspace-dashboard";
import { startDashboardServer } from "../../../code/src/dashboard-server";
import { recordConfigApplied } from "../../../code/src/lib/workspace/config-reload";
import { workspaceConfigPath, workspaceDbPath } from "../../../code/src/lib/workspace/paths";

const [workspaceDir, portArg] = process.argv.slice(2);
if (!workspaceDir || !portArg) {
  console.error("Usage: bun run scripts/demo/serve.ts <workspace-dir> <port>");
  process.exit(1);
}

writeFileSync(
  join(workspaceDir, ".worker.lock"),
  JSON.stringify({ pid: process.pid, timestamp: new Date(Date.now() - 3 * 86_400_000 - 5 * 3_600_000).toISOString() }),
);

// The worker "started" 3 days ago and applied the config then: mark it in sync.
const configPath = workspaceConfigPath(workspaceDir);
const edited = new Date(Date.now() - 4 * 86_400_000);
utimesSync(configPath, edited, edited);
recordConfigApplied(workspaceDir, configPath, Date.now() - 3 * 86_400_000);

const dbPath = workspaceDbPath(workspaceDir);
startDashboardServer({
  port: Number(portArg),
  dbPath,
  queueDbPath: dbPath,
  workspaceDir,
  workingDir: workspaceDir,
  automationActions: loadWorkspaceAutomationActions(workspaceDir),
  logDirs: [],
  scheduleSnapshot: () => null,
});
