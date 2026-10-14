import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
  HARNESS_LOG_PRUNE_INTERVAL_MS,
  isHarnessLoggingEnabled,
  listHarnessLogs,
  maybePruneHarnessLogs,
  parseHarnessLogName,
  pruneHarnessLogs,
  readHarnessLogContent,
} from "../src/lib/observability/harness-logs";
import { beginRun, endRun, getActiveRunContext } from "../src/lib/state/run-recorder";

const HARNESS = {
  name: "claude-code",
  displayName: "Claude Code",
  supportsMaxTurns: true,
} as Pick<AgentHarness, "name" | "displayName" | "supportsMaxTurns">;

describe("harness run logs", () => {
  let root: string;
  let savedWorkspace: string | undefined;
  let savedFlag: string | undefined;
  let savedMaxFile: string | undefined;
  let savedMaxTotal: string | undefined;
  let savedRetentionDays: string | undefined;
  let savedMaxFiles: string | undefined;

  const ENV_KEYS = {
    workspace: "DEVINTERN_WORKSPACE_DIR",
    flag: "DEVINTERN_HARNESS_LOGS",
    maxFile: "DEVINTERN_HARNESS_LOG_MAX_FILE_MB",
    maxTotal: "DEVINTERN_HARNESS_LOG_MAX_TOTAL_MB",
    retentionDays: "DEVINTERN_HARNESS_LOG_RETENTION_DAYS",
    maxFiles: "DEVINTERN_HARNESS_LOG_MAX_FILES",
  } as const;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harness-logs-"));
    savedWorkspace = process.env[ENV_KEYS.workspace];
    savedFlag = process.env[ENV_KEYS.flag];
    savedMaxFile = process.env[ENV_KEYS.maxFile];
    savedMaxTotal = process.env[ENV_KEYS.maxTotal];
    savedRetentionDays = process.env[ENV_KEYS.retentionDays];
    savedMaxFiles = process.env[ENV_KEYS.maxFiles];
    process.env[ENV_KEYS.workspace] = root;
    delete process.env[ENV_KEYS.flag];
    delete process.env[ENV_KEYS.maxFile];
    delete process.env[ENV_KEYS.maxTotal];
    delete process.env[ENV_KEYS.retentionDays];
    delete process.env[ENV_KEYS.maxFiles];
  });

  afterEach(() => {
    const restore = (key: string, saved: string | undefined): void => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    };
    restore(ENV_KEYS.workspace, savedWorkspace);
    restore(ENV_KEYS.flag, savedFlag);
    restore(ENV_KEYS.maxFile, savedMaxFile);
    restore(ENV_KEYS.maxTotal, savedMaxTotal);
    restore(ENV_KEYS.retentionDays, savedRetentionDays);
    restore(ENV_KEYS.maxFiles, savedMaxFiles);
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
    expect(content).toContain("first line\nsecond line\n");
    expect(content).toContain("a warning\n");
    expect(content).toContain("=== end of harness run ===");
    expect(content).toContain("exitCode: 0");
    expect(content).toContain("maxTurnsReached: false");
  });

  test("writes chunks contiguously without per-line decoration", () => {
    const sink = createHarnessLogSink({ harness: HARNESS, label: "implementation" });
    sink!.stdout("first ");
    sink!.stdout("line\nsecond");
    sink!.stdout(" line\n");
    sink!.close({ exitCode: 0, signal: null });
    const files = readdirSync(harnessLogsDir());
    const content = readFileSync(join(harnessLogsDir(), files[0]!), "utf8");
    expect(content).toContain("first line\nsecond line\n");
  });

  test("keeps one line intact when delivered across chunks", () => {
    const sink = createHarnessLogSink({ harness: HARNESS, label: "implementation" });
    sink!.stdout("abc");
    sink!.stdout("def");
    sink!.stdout("ghi\n");
    sink!.close({ exitCode: 0, signal: null });
    const files = readdirSync(harnessLogsDir());
    const content = readFileSync(join(harnessLogsDir(), files[0]!), "utf8");
    expect(content).toContain("abcdefghi\n");
    expect(content).not.toContain("abc\n");
  });

  test("flushes a trailing partial line at close", () => {
    const sink = createHarnessLogSink({ harness: HARNESS, label: "implementation" });
    sink!.stdout("no trailing newline");
    sink!.close({ exitCode: 0, signal: null });
    const files = readdirSync(harnessLogsDir());
    const content = readFileSync(join(harnessLogsDir(), files[0]!), "utf8");
    expect(content).toContain("no trailing newline\n");
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

  test("round-trips keys and labels containing underscores without shifting fields", () => {
    const cases = [
      { taskKey: "DEV-128", label: "implementation", task: "DEV-128", tag: "implementation" },
      { taskKey: "DEV_128", label: "unit_test", task: "DEV_128", tag: "unit_test" },
      { taskKey: "DEV__128", label: "__review__", task: "DEV_128", tag: "review" },
      { taskKey: "DEV_", label: "review", task: "DEV", tag: "review" },
      { taskKey: "_DEV", label: "_review_", task: "DEV", tag: "review" },
    ];
    for (const item of cases) {
      const name = harnessLogFileName({
        startedAt: new Date(),
        origin: "task",
        taskKey: item.taskKey,
        label: item.label,
      });
      // No segment may bleed into the `__` separator and form `___`, which
      // would shift every field parsed after it.
      expect(name).not.toContain("___");
      const parsed = parseHarnessLogName(name);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskKey).toBe(item.task);
      expect(parsed!.label).toBe(item.tag);
    }
  });

  test("discovers a log by a task key the namer sanitizes", () => {
    const sink = createHarnessLogSink({ harness: HARNESS, taskKey: "DEV_" });
    sink!.close({ exitCode: 0, signal: null });
    const files = listHarnessLogs({ taskKey: "DEV_" });
    expect(files.length).toBe(1);
    expect(files[0]?.taskKey).toBe("DEV");
  });

  test("respects the list limit, newest first", () => {
    for (let index = 0; index < 3; index++) {
      const sink = createHarnessLogSink({
        harness: HARNESS,
        taskKey: `DEV-${index}`,
        label: "implementation",
      });
      sink!.close({ exitCode: 0, signal: null });
    }
    const limited = listHarnessLogs({ limit: 2 });
    expect(limited.length).toBe(2);
    expect(limited[0]!.startedAt ?? 0).toBeGreaterThanOrEqual(limited[1]!.startedAt ?? 0);
  });

  test("attributes a sink to the active run so the dashboard can match it", () => {
    beginRun({ origin: "estimate", taskKey: "DEV-9", harness: HARNESS.name });
    try {
      const active = getActiveRunContext();
      expect(active).not.toBeNull();
      const sink = createHarnessLogSink({
        harness: HARNESS,
        label: "estimation",
        origin: "estimate",
        taskKey: "DEV-9",
      });
      sink!.stdout("working\n");
      sink!.close({ exitCode: 0, signal: null });

      const files = listHarnessLogs({ runId: active!.id });
      expect(files.length).toBe(1);
      expect(files[0]?.origin).toBe("estimate");
      expect(files[0]?.taskKey).toBe("DEV-9");
    } finally {
      endRun("succeeded");
    }
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
      "=== devintern harness run ===\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz\ndone\n",
    );
    const content = readHarnessLogContent(name);
    expect(content).not.toBeNull();
    expect(content!.content).toContain("done");
    expect(content!.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(content!.content).toContain("[redacted]");
  });

  test("redacts multi-line private keys and colon assignments when serving a log", () => {
    const name = harnessLogFileName({
      startedAt: new Date(),
      origin: "task",
      runId: 4,
      taskKey: "DEV-4",
      label: "review",
    });
    mkdirSync(harnessLogsDir(), { recursive: true });
    writeFileSync(
      join(harnessLogsDir(), name),
      [
        "=== devintern harness run ===",
        '"api_key": "sk-abcdefghijklmnopqrstuvwxyz123456"',
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz",
        "-----END RSA PRIVATE KEY-----",
        "done",
        "",
      ].join("\n"),
    );
    const content = readHarnessLogContent(name);
    expect(content).not.toBeNull();
    expect(content!.content).not.toContain("MIIEowIBAAKCAQEA");
    expect(content!.content).toContain("[redacted private key]");
    expect(content!.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(content!.content).toContain("done");
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

  test("budgets total directory bytes, pruning oldest first", () => {
    mkdirSync(harnessLogsDir(), { recursive: true });
    const base = Date.now();
    for (let index = 0; index < 3; index++) {
      const name = harnessLogFileName({
        startedAt: new Date(base + index * 1000),
        origin: "task",
        taskKey: `DEV-${index}`,
        label: "implementation",
      });
      const path = join(harnessLogsDir(), name);
      writeFileSync(path, "x".repeat(400));
      const stamp = new Date(base - (3 - index) * 1000);
      utimesSync(path, stamp, stamp);
    }
    pruneHarnessLogs(harnessLogsDir(), { maxBytes: 800 });
    const remaining = readdirSync(harnessLogsDir());
    expect(remaining.length).toBe(2);
    // The oldest file (lowest index / oldest mtime) is the one removed.
    expect(remaining.some((name) => name.includes("DEV-0"))).toBe(false);
  });

  test("honors the retention-days, max-files, and max-total env overrides", () => {
    mkdirSync(harnessLogsDir(), { recursive: true });

    // Retention window: a file older than one day is pruned by the env value.
    const oldName = harnessLogFileName({
      startedAt: new Date(),
      origin: "task",
      taskKey: "OLD-1",
      label: "implementation",
    });
    const oldPath = join(harnessLogsDir(), oldName);
    writeFileSync(oldPath, "old");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, old, old);
    process.env.DEVINTERN_HARNESS_LOG_RETENTION_DAYS = "1";
    pruneHarnessLogs(harnessLogsDir());
    expect(existsSync(oldPath)).toBe(false);
    delete process.env.DEVINTERN_HARNESS_LOG_RETENTION_DAYS;

    // File cap: keep only the newest two of three fresh files.
    const base = Date.now();
    for (let index = 0; index < 3; index++) {
      const name = harnessLogFileName({
        startedAt: new Date(base + index * 1000),
        origin: "task",
        taskKey: `DEV-${index}`,
        label: "implementation",
      });
      writeFileSync(join(harnessLogsDir(), name), "x");
    }
    process.env.DEVINTERN_HARNESS_LOG_MAX_FILES = "2";
    pruneHarnessLogs(harnessLogsDir());
    expect(readdirSync(harnessLogsDir()).length).toBe(2);
    delete process.env.DEVINTERN_HARNESS_LOG_MAX_FILES;

    // Byte budget: a 1 MB env cap drops one of two ~600 KB files.
    rmSync(harnessLogsDir(), { recursive: true, force: true });
    mkdirSync(harnessLogsDir(), { recursive: true });
    for (let index = 0; index < 2; index++) {
      const name = harnessLogFileName({
        startedAt: new Date(base + index * 1000),
        origin: "task",
        taskKey: `BIG-${index}`,
        label: "implementation",
      });
      writeFileSync(join(harnessLogsDir(), name), "x".repeat(600 * 1024));
    }
    process.env.DEVINTERN_HARNESS_LOG_MAX_TOTAL_MB = "1";
    pruneHarnessLogs(harnessLogsDir());
    expect(readdirSync(harnessLogsDir()).length).toBe(1);
  });

  test("truncates a single transcript at the per-file byte cap", () => {
    process.env.DEVINTERN_HARNESS_LOG_MAX_FILE_MB = "1";
    const cap = 1024 * 1024;
    const sink = createHarnessLogSink({ harness: HARNESS, label: "implementation" });
    sink!.stdout("a".repeat(cap + 4096));
    sink!.close({ exitCode: 0, signal: null });

    const files = readdirSync(harnessLogsDir());
    expect(files.length).toBe(1);
    const path = join(harnessLogsDir(), files[0]!);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(`truncated at ${cap} bytes`);
    expect(content).toContain("truncated: true");
    // Body is capped; the header, truncation notice, and footer add only a
    // small, bounded overhead.
    expect(statSync(path).size).toBeLessThan(cap + 4096);
  });

  test("throttles opportunistic pruning between spawns", () => {
    const name = harnessLogFileName({
      startedAt: new Date(),
      origin: "task",
      taskKey: "OLD-1",
      label: "implementation",
    });
    const path = join(harnessLogsDir(), name);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const base = Date.now();

    mkdirSync(harnessLogsDir(), { recursive: true });
    writeFileSync(path, "old");
    utimesSync(path, old, old);
    maybePruneHarnessLogs(harnessLogsDir(), base);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, "old");
    utimesSync(path, old, old);
    maybePruneHarnessLogs(harnessLogsDir(), base + 1000);
    expect(existsSync(path)).toBe(true);

    maybePruneHarnessLogs(harnessLogsDir(), base + HARNESS_LOG_PRUNE_INTERVAL_MS + 1);
    expect(existsSync(path)).toBe(false);
  });
});
