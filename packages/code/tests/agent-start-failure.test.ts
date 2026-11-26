import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AGENT_START_MAX_ATTEMPTS_ENV,
  DEFAULT_AGENT_START_MAX_ATTEMPTS,
  agentStartFixHint,
  agentStartMaxAttempts,
  agentStartReason,
  agentStartRetryDelayMs,
  parseAgentStartReason,
} from "../src/lib/agent/agent-start-failure";
import { detectHarnessStartupFailure } from "../src/lib/agent/harness-startup";
import {
  readAgentStartFailureStreak,
  readAgentStartFailures,
  renderAgentStartFailures,
} from "../src/lib/observability/agent-start-health";
import { collectQueuedWork } from "../src/lib/observability/queued-work";
import { RunStore } from "../src/lib/state/run-recorder";

describe("agent start retry budget", () => {
  test("max attempts default, env override, and invalid overrides", () => {
    expect(agentStartMaxAttempts({})).toBe(DEFAULT_AGENT_START_MAX_ATTEMPTS);
    expect(agentStartMaxAttempts({ [AGENT_START_MAX_ATTEMPTS_ENV]: "2" })).toBe(2);
    for (const bad of ["0", "-1", "1.5", "lots", " "]) {
      expect(agentStartMaxAttempts({ [AGENT_START_MAX_ATTEMPTS_ENV]: bad })).toBe(
        DEFAULT_AGENT_START_MAX_ATTEMPTS,
      );
    }
  });

  test("retry delay doubles from one minute and caps at 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => agentStartRetryDelayMs(n) / 60_000)).toEqual([
      1, 2, 4, 8, 16, 30, 30,
    ]);
  });

  test("reason round-trips, is one line, and redacts credentials", () => {
    const reason = agentStartReason(
      "Claude Code (claude) could not start: exited with code 1 before producing output: " +
        "Invalid API key ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nsecond line",
    );
    expect(reason.startsWith("agent_start: Claude Code (claude) could not start")).toBe(true);
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(parseAgentStartReason(reason)).toBe(reason.slice("agent_start: ".length));
    expect(parseAgentStartReason("verify: tests failed")).toBeUndefined();
    expect(parseAgentStartReason(null)).toBeUndefined();
  });

  test("fix hints name the login step, the install step, or the sandbox", () => {
    expect(agentStartFixHint("claude-code", "exited with code 1")).toContain("run `claude`");
    expect(agentStartFixHint("claude-code", "exited with code 1")).toContain("ANTHROPIC_API_KEY");
    expect(agentStartFixHint("codex", "exited with code 1")).toContain("codex login");
    expect(agentStartFixHint("claude-code", "Claude Code CLI not found at: claude")).toContain(
      "install the agent CLI",
    );
    expect(agentStartFixHint(undefined, "sandbox initialization failed")).toContain(
      "devintern sandbox",
    );
    expect(agentStartFixHint("unknown-harness", "exited with code 1")).toContain(
      "run the agent CLI once in a terminal",
    );
  });
});

describe("startup classification keeps the stderr tail", () => {
  test("a fast exit 1 with only stderr names the exit and the error", () => {
    const failure = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "Invalid API key · Please run /login\n",
      durationMs: 300,
    });
    expect(failure?.reason).toBe(
      "exited with code 1 before producing output: Invalid API key · Please run /login",
    );
  });

  test("a fast silent exit still says what happened", () => {
    const failure = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "",
      durationMs: 300,
    });
    expect(failure?.reason).toBe("exited with code 1 before producing output");
  });

  test("the stderr tail is redacted", () => {
    const failure = detectHarnessStartupFailure({
      exitCode: 1,
      stdout: "",
      stderr: "auth error: OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 rejected\n",
      durationMs: 300,
    });
    expect(failure?.reason).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(failure?.reason).toContain("before producing output: auth error");
  });
});

describe("start-failure runs", () => {
  let dir: string;
  let dbPath: string;
  let store: RunStore;
  const startFailure = agentStartReason(
    "Claude Code (claude) could not start: exited with code 1 before producing output: Invalid API key",
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-start-failure-"));
    dbPath = join(dir, "queue.db");
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(taskKey: string, status: "deferred" | "failed" | "succeeded", reason?: string) {
    const id = store.createRun({ origin: "task", taskKey, harness: "claude-code", repo: "app" });
    store.finishRun(id, status, reason);
    return id;
  }

  test("the streak counts consecutive deferred start failures only", () => {
    run("APP-1", "succeeded");
    run("APP-1", "deferred", startFailure);
    run("APP-1", "deferred", "usage limit");
    run("APP-1", "deferred", startFailure);
    run("APP-1", "deferred", startFailure);
    const current = store.createRun({ origin: "task", taskKey: "APP-1" });
    expect(readAgentStartFailureStreak(dbPath, "APP-1", current)).toBe(2);

    // A run that gave up ends the streak, so a retry starts a fresh budget.
    run("APP-2", "deferred", startFailure);
    run("APP-2", "failed", startFailure);
    expect(readAgentStartFailureStreak(dbPath, "APP-2")).toBe(0);
    expect(readAgentStartFailureStreak(dbPath, "NONE")).toBe(0);
    expect(readAgentStartFailureStreak(join(dir, "missing.db"), "APP-1")).toBe(0);
  });

  test("status lists the latest start failure per task with attempts, error, and hint", () => {
    run("APP-1", "deferred", startFailure);
    run("APP-1", "deferred", startFailure);
    run("APP-1", "deferred", startFailure);
    run("APP-2", "deferred", startFailure);
    run("APP-2", "failed", startFailure);
    // Superseded by a later run that started the agent.
    run("APP-3", "deferred", startFailure);
    run("APP-3", "succeeded");

    const failures = readAgentStartFailures(dbPath);
    expect(
      failures.map(({ taskKey, state, attempts, repo, harness }) => ({
        taskKey,
        state,
        attempts,
        repo,
        harness,
      })),
    ).toEqual([
      { taskKey: "APP-2", state: "failed", attempts: 2, repo: "app", harness: "claude-code" },
      { taskKey: "APP-1", state: "retrying", attempts: 3, repo: "app", harness: "claude-code" },
    ]);
    expect(failures[0]!.error).toContain("Invalid API key");
    expect(failures[0]!.hint).toContain("ANTHROPIC_API_KEY");

    const text = renderAgentStartFailures(failures).join("\n");
    expect(text).toContain("the agent CLI is failing to start");
    expect(text).toContain("APP-1 (app): retrying with backoff (3 attempt(s) so far)");
    expect(text).toContain("APP-2 (app): gave up after 2 attempt(s)");
    expect(text).toContain("Error: Claude Code (claude) could not start");
    expect(text).toContain("Fix:   run `claude` once in a terminal to log in");
    expect(text).toContain("devintern worker add --resume");
  });

  test("a run that gave up is an environment failure and raises a notification", () => {
    const id = store.createRun({ origin: "task", taskKey: "APP-9", harness: "claude-code" });
    store.finishRun(id, "failed", startFailure, {
      failure: { outcomeClass: "environment", stage: "agent_start", cause: "Invalid API key" },
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      const kinds = db.query("SELECT kind FROM notifications").all() as Array<{ kind: string }>;
      expect(kinds.map((row) => row.kind)).toContain("source_unhealthy");
    } finally {
      db.close();
    }
  });

  test("old failures fall out of the window; a missing database reads as none", () => {
    run("APP-1", "deferred", startFailure);
    expect(readAgentStartFailures(dbPath, { now: Date.now() + 25 * 60 * 60_000 })).toEqual([]);
    expect(readAgentStartFailures(join(dir, "missing.db"))).toEqual([]);
    expect(renderAgentStartFailures([])).toEqual([]);
  });

  test("the queue response carries start failures only when there are any", () => {
    const sources = {
      dbPath,
      queueDbPath: dbPath,
      listInjected: () => [],
      lookupRun: () => null,
      pendingTotal: 0,
    };
    expect(collectQueuedWork(sources).agentStartFailures).toBeUndefined();
    run("APP-1", "deferred", startFailure);
    const body = collectQueuedWork(sources);
    expect(body.items).toEqual([]);
    expect(body.agentStartFailures?.map((failure) => failure.taskKey)).toEqual(["APP-1"]);
  });
});
