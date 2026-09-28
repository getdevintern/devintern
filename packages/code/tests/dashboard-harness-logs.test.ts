import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DashboardData,
  handleRunDetail,
  handleRunHarnessLog,
  handleRunHarnessLogs,
} from "../src/lib/observability/dashboard-api";
import { harnessLogFileName, harnessLogsDir } from "../src/lib/observability/harness-logs";
import { RunStore } from "../src/lib/state/run-recorder";

describe("dashboard harness logs", () => {
  let dir: string;
  let workspaceDir: string;
  let dbPath: string;
  let data: DashboardData;
  let savedWorkspace: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-harness-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "dash-harness-ws-"));
    savedWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    dbPath = join(dir, "queue.db");
    data = new DashboardData({ dbPath, workingDir: dir });
  });

  afterEach(() => {
    data.close();
    if (savedWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspace;
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function seedRunWithLog(): { runId: number; name: string } {
    const store = new RunStore(dbPath);
    const runId = store.createRun({ origin: "task", taskKey: "DEV-128", harness: "claude-code" });
    store.close();

    const name = harnessLogFileName({
      startedAt: new Date(),
      origin: "task",
      runId,
      taskKey: "DEV-128",
      label: "implementation",
    });
    mkdirSync(harnessLogsDir(workspaceDir), { recursive: true });
    writeFileSync(
      join(harnessLogsDir(workspaceDir), name),
      "=== devintern harness run ===\ntaskKey: DEV-128\n[out] token=ghp_abcdefghijklmnopqrstuvwxyz\n",
    );
    return { runId, name };
  }

  test("run detail lists harness logs attributed to the run", () => {
    const { runId } = seedRunWithLog();
    const response = handleRunDetail(data, String(runId));
    expect(response.status).toBe(200);
    const body = response.body as { harnessLogs: { name: string; label?: string }[] };
    expect(body.harnessLogs.length).toBe(1);
    expect(body.harnessLogs[0]?.label).toBe("implementation");
  });

  test("lists harness logs as JSON for a run", () => {
    const { runId } = seedRunWithLog();
    const response = handleRunHarnessLogs(data, String(runId));
    expect(response.status).toBe(200);
    const body = response.body as { harnessLogs: { label?: string }[] };
    expect(body.harnessLogs.length).toBe(1);
    expect(body.harnessLogs[0]?.label).toBe("implementation");
  });

  test("serves a redacted log scoped to its run", () => {
    const { runId, name } = seedRunWithLog();
    const response = handleRunHarnessLog(data, String(runId), encodeURIComponent(name));
    expect(response.status).toBe(200);
    const body = response.body as { content: string };
    expect(body.content).toContain("[out]");
    expect(body.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(body.content).toContain("[redacted]");
  });

  test("404s for an unknown run, unknown log, and invalid id", () => {
    const { runId, name } = seedRunWithLog();
    expect(handleRunHarnessLog(data, String(runId), "missing.log").status).toBe(404);
    expect(handleRunHarnessLog(data, "99999", encodeURIComponent(name)).status).toBe(404);
    expect(handleRunHarnessLog(data, "abc", encodeURIComponent(name)).status).toBe(400);
  });
});
