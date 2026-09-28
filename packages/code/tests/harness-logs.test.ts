import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentHarness } from "@devintern/agent-harness";
import {
  createHarnessLogSink,
  harnessLogFileName,
  harnessLogsDir,
  isHarnessLoggingEnabled,
  listHarnessLogs,
  parseHarnessLogName,
  pruneHarnessLogs,
  readHarnessLogContent,
} from "../src/lib/observability/harness-logs";

const HARNESS = {
  name: "claude-code",
  displayName: "Claude Code",
  supportsMaxTurns: true,
} as Pick<AgentHarness, "name" | "displayName" | "supportsMaxTurns">;

describe("harness run logs", () => {
  let root: string;
  let savedWorkspace: string | undefined;
  let savedFlag: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harness-logs-"));
    savedWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
    savedFlag = process.env.DEVINTERN_HARNESS_LOGS;
    process.env.DEVINTERN_WORKSPACE_DIR = root;
    delete process.env.DEVINTERN_HARNESS_LOGS;
  });

  afterEach(() => {
    if (savedWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspace;
    if (savedFlag === undefined) delete process.env.DEVINTERN_HARNESS_LOGS;
    else process.env.DEVINTERN_HARNESS_LOGS = savedFlag;
    rmSync(root, { recursive: true, force: true });
  });

  test("resolves the log directory under the workspace home", () => {
    expect(harnessLogsDir()).toBe(join(root, "logs", "harness"));
  });

  test("writes header, both streams, and footer", () => {
    const sink = createHarnessLogSink({
      harness: HARNESS,
      label: "implementation",
      taskKey: "DEV-128",
      command: ["agent", "-p", "do the thing"],
    });
    expect(sink).toBeDefined();
    sink!.stdout("first line\nsecond line\n");
    sink!.stderr("a warning\n");
    sink!.close({ exitCode: 0, signal: null });

    const files = readdirSync(harnessLogsDir());
    expect(files.length).toBe(1);
    const content = readFileSync(join(harnessLogsDir(), files[0]!), "utf8");
    expect(content).toContain("=== devintern harness run ===");
    expect(content).toContain("origin: task");
    expect(content).toContain("taskKey: DEV-128");
    expect(content).toContain("harness: claude-code");
    expect(content).toContain("label: implementation");
    expect(content).toContain("command: agent -p do the thing");
    expect(content).toContain("[out] first line");
    expect(content).toContain("[out] second line");
    expect(content).toContain("[err] a warning");
    expect(content).toContain("=== end of harness run ===");
    expect(content).toContain("exitCode: 0");
    expect(content).toContain("maxTurnsReached: false");
  });

  test("records a max-turns termination from partial output", () => {
    const sink = createHarnessLogSink({ harness: HARNESS, label: "implementation" });
    sink!.stdout("Working...\nMaximum turns reached\n");
    sink!.close({ exitCode: 0, signal: null });
    const files = readdirSync(harnessLogsDir());
    const content = readFileSync(join(harnessLogsDir(), files[0]!), "utf8");
    expect(content).toContain("maxTurnsReached: true");
  });

  test("is disabled with DEVINTERN_HARNESS_LOGS=0", () => {
    process.env.DEVINTERN_HARNESS_LOGS = "0";
    expect(isHarnessLoggingEnabled()).toBe(false);
    expect(createHarnessLogSink({ harness: HARNESS })).toBeUndefined();
    expect(() => readdirSync(harnessLogsDir())).toThrow();
  });

  test("filters logs by task key and run id, newest first", () => {
    const a = createHarnessLogSink({ harness: HARNESS, taskKey: "DEV-1" });
    a!.close({ exitCode: 0, signal: null });
    const b = createHarnessLogSink({ harness: HARNESS, taskKey: "DEV-2" });
    b!.close({ exitCode: 0, signal: null });

    expect(listHarnessLogs({ taskKey: "DEV-1" }).map((file) => file.taskKey)).toEqual(["DEV-1"]);
    expect(listHarnessLogs().length).toBe(2);

    const named = harnessLogFileName({
      startedAt: new Date(),
      origin: "pr_mention",
      runId: 7,
      taskKey: "DEV-7",
      label: "review",
    });
    writeFileSync(join(harnessLogsDir(), named), "=== devintern harness run ===\n");
    expect(listHarnessLogs({ runId: 7 }).map((file) => file.runId)).toEqual([7]);
    expect(parseHarnessLogName(named)?.origin).toBe("pr_mention");
  });

  test("reads a log tail with secrets redacted", () => {
    const name = harnessLogFileName({
      startedAt: new Date(),
      origin: "task",
      runId: 3,
      taskKey: "DEV-3",
      label: "implementation",
    });
    mkdirSync(harnessLogsDir(), { recursive: true });
    writeFileSync(
      join(harnessLogsDir(), name),
      "=== devintern harness run ===\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz\n[out] done\n",
    );
    const content = readHarnessLogContent(name);
    expect(content).not.toBeNull();
    expect(content!.content).toContain("[out] done");
    expect(content!.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(content!.content).toContain("[redacted]");
  });

  test("rejects path traversal in log names", () => {
    expect(readHarnessLogContent("../../etc/passwd")).toBeNull();
  });

  test("prunes logs older than the retention window", () => {
    const name = harnessLogFileName({
      startedAt: new Date(),
      origin: "task",
      taskKey: "OLD-1",
      label: "implementation",
    });
    const path = join(harnessLogsDir(), name);
    mkdirSync(harnessLogsDir(), { recursive: true });
    writeFileSync(path, "old");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(path, old, old);

    pruneHarnessLogs(harnessLogsDir(), { retentionDays: 1 });
    expect(() => statSync(path)).toThrow();
  });

  test("caps the number of retained logs", () => {
    mkdirSync(harnessLogsDir(), { recursive: true });
    for (let index = 0; index < 3; index++) {
      const name = harnessLogFileName({
        startedAt: new Date(Date.now() + index * 1000),
        origin: "task",
        taskKey: `DEV-${index}`,
        label: "implementation",
      });
      writeFileSync(join(harnessLogsDir(), name), "x");
    }
    pruneHarnessLogs(harnessLogsDir(), { maxFiles: 2 });
    expect(readdirSync(harnessLogsDir()).length).toBe(2);
  });
});
