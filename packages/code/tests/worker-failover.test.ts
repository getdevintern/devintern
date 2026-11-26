import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { UsageLimitError } from "@devintern/agent-harness";

import { WebhookQueue } from "../src/lib/state/webhook-queue";
import {
  cliResultToTaskResult,
  getWorkerFailover,
  harnessBlockedReason,
  harnessChainBlockedUntil,
  WorkerFailover,
  resetWorkerFailover,
  runWithFailover,
  startWorkerFailover,
} from "../src/lib/worker/failover";
import {
  AUTOMATION_ACCESS_EXIT_CODE,
  HARNESS_UNAVAILABLE_EXIT_CODE,
  readUsageLimitHint,
  TASK_SKIP_EXIT_CODE,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
  writeUsageLimitHint,
  WORKTREE_BUSY_EXIT_CODE,
} from "../src/lib/worker/usage-limit-protocol";

afterEach(() => {
  resetWorkerFailover();
});

describe("runWithFailover", () => {
  test("defers an access-denied child without trying another harness", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });
    let calls = 0;
    const result = await runWithFailover(async () => {
      calls++;
      return AUTOMATION_ACCESS_EXIT_CODE;
    });
    expect(result).toBe("deferred");
    expect(calls).toBe(1);
  });

  test("without a worker controller, a usage-limit exit is a plain failure", async () => {
    const result = await runWithFailover(async () => USAGE_LIMIT_EXIT_CODE);
    expect(result).toBe("failed");
  });

  test("retries the same spawn on the next harness after exit 75", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    const seen: string[] = [];
    const result = await runWithFailover(async (env) => {
      seen.push(env.AGENT_HARNESS ?? "");
      if (seen.length === 1) {
        writeFileSync(
          env[USAGE_LIMIT_FILE_ENV]!,
          JSON.stringify({ untilMs: Date.now() + 60_000, resetsAt: "4:27 PM" }),
        );
        return USAGE_LIMIT_EXIT_CODE;
      }
      return 0;
    });

    expect(result).toBe("ok");
    expect(seen).toEqual(["codex", "grok"]);
  });

  test("a limit from a run that started before another run failed over stays on its harness", async () => {
    const failover = await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    // Two concurrent task runs both start on codex.
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowSeen: string[] = [];
    const slow = runWithFailover(async (env) => {
      slowSeen.push(env.AGENT_HARNESS ?? "");
      if (slowSeen.length === 1) {
        await slowGate;
        writeFileSync(env[USAGE_LIMIT_FILE_ENV]!, JSON.stringify({ untilMs: Date.now() + 60_000 }));
        return USAGE_LIMIT_EXIT_CODE;
      }
      return 0;
    });

    const fastSeen: string[] = [];
    const fast = await runWithFailover(async (env) => {
      fastSeen.push(env.AGENT_HARNESS ?? "");
      if (fastSeen.length === 1) {
        writeFileSync(env[USAGE_LIMIT_FILE_ENV]!, JSON.stringify({ untilMs: Date.now() + 60_000 }));
        return USAGE_LIMIT_EXIT_CODE;
      }
      return 0;
    });
    expect(fast).toBe("ok");
    expect(fastSeen).toEqual(["codex", "grok"]);

    // The slow codex run now reports the same codex limit; grok must stay open.
    releaseSlow();
    expect(await slow).toBe("ok");
    expect(slowSeen).toEqual(["codex", "grok"]);
    expect(failover.activeName).toBe("grok");
    expect(failover.manager.isLimited("grok")).toBe(false);
    expect(failover.allLimited()).toBe(false);
  });

  test("returns deferred when every harness in the chain is limited", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    const result = await runWithFailover(async (env) => {
      writeFileSync(env[USAGE_LIMIT_FILE_ENV]!, JSON.stringify({ untilMs: Date.now() + 60_000 }));
      return USAGE_LIMIT_EXIT_CODE;
    });

    expect(result).toBe("deferred");
  });

  test("tries the next entry when a harness cannot start", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    const seen: string[] = [];
    const result = await runWithFailover(async (env) => {
      seen.push(env.AGENT_HARNESS ?? "");
      return seen.length === 1 ? HARNESS_UNAVAILABLE_EXIT_CODE : 0;
    });

    expect(result).toBe("ok");
    expect(seen).toEqual(["codex", "grok"]);
  });

  test("defers without burning an attempt when no harness can start", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    const seen: string[] = [];
    const result = await runWithFailover(async (env) => {
      seen.push(env.AGENT_HARNESS ?? "");
      return HARNESS_UNAVAILABLE_EXIT_CODE;
    });

    expect(result).toBe("deferred");
    expect(seen).toEqual(["codex", "grok"]);
  });

  test("pins AGENT_HARNESS to the active entry on the first attempt", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok,cursor",
      log: () => {},
    });

    const result = await runWithFailover(async (env) => {
      expect(env.AGENT_HARNESS).toBe("codex");
      expect(env.DEVINTERN_HARNESS_CHAIN).toBe("codex,grok,cursor");
      expect(env.DEVINTERN_WORKER_CHILD).toBe("1");
      return 0;
    });
    expect(result).toBe("ok");
  });

  test("reports a retry-gate skip without trying another harness", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    let calls = 0;
    const result = await runWithFailover(async () => {
      calls++;
      return TASK_SKIP_EXIT_CODE;
    });

    expect(result).toBe("skipped");
    expect(calls).toBe(1);
  });

  test("without a worker controller, exit 3 is still a skip", async () => {
    const result = await runWithFailover(async () => TASK_SKIP_EXIT_CODE);
    expect(result).toBe("skipped");
  });

  test("defers a busy-worktree exit without trying another harness", async () => {
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });
    let calls = 0;
    const result = await runWithFailover(async () => {
      calls++;
      return WORKTREE_BUSY_EXIT_CODE;
    });
    expect(result).toBe("deferred");
    expect(calls).toBe(1);
  });

  test("defers a busy-worktree exit without a controller or with a pinned harness", async () => {
    expect(await runWithFailover(async () => WORKTREE_BUSY_EXIT_CODE)).toBe("deferred");
    expect(
      await runWithFailover(async () => WORKTREE_BUSY_EXIT_CODE, process.env, {
        harnessPin: "codex",
      }),
    ).toBe("deferred");
  });
});

describe("cliResultToTaskResult", () => {
  test("maps ok, deferred, skipped, and failure distinctly", () => {
    expect(cliResultToTaskResult("ok")).toBe(true);
    expect(cliResultToTaskResult("deferred")).toBe("deferred");
    expect(cliResultToTaskResult("skipped")).toBe("skipped");
    expect(cliResultToTaskResult("failed")).toBe(false);
  });
});

describe("worker startup model diagnostics", () => {
  test("lists the effective model per chain entry and marks fallbacks without one", async () => {
    const originalModel = process.env.AGENT_MODEL;
    const originalGrokModel = process.env.GROK_MODEL;
    const lines: string[] = [];
    try {
      process.env.AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
      delete process.env.GROK_MODEL;
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode,grok",
        log: (message) => lines.push(message),
      });
    } finally {
      if (originalModel === undefined) delete process.env.AGENT_MODEL;
      else process.env.AGENT_MODEL = originalModel;
      if (originalGrokModel === undefined) delete process.env.GROK_MODEL;
      else process.env.GROK_MODEL = originalGrokModel;
    }

    expect(lines).toContain("   Models: opencode: opencode-go/deepseek-v4.1-flash | grok: default");
  });
});

describe("worker startup with a stale persisted active harness", () => {
  test("the selected fallback is persisted so the next start does not re-warn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-stale-active-"));
    const dbPath = join(dir, "queue.db");
    const seed = new WebhookQueue({ dbPath });
    seed.setActiveHarness("codex");
    seed.close();

    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      const firstQueue = new WebhookQueue({ dbPath });
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode,grok,cursor",
        queue: firstQueue,
        log: () => {},
      });
      firstQueue.close();
      expect(warnings.filter((line) => line.includes("Persisted active harness"))).toHaveLength(1);

      const reopened = new WebhookQueue({ dbPath });
      expect(reopened.getActiveHarness()).toBe("opencode");

      const secondWarnings: string[] = [];
      console.warn = (...args: unknown[]) => secondWarnings.push(args.join(" "));
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode,grok,cursor",
        queue: reopened,
        log: () => {},
      });
      reopened.close();
      expect(secondWarnings.filter((line) => line.includes("Persisted active harness"))).toEqual(
        [],
      );
    } finally {
      console.warn = originalWarn;
      resetWorkerFailover();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker startup with corrupt persisted meta", () => {
  test("starts on the primary harness instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-corrupt-meta-"));
    const dbPath = join(dir, "queue.db");
    const seed = new WebhookQueue({ dbPath });
    seed.close();

    const { Database } = require("bun:sqlite");
    const raw = new Database(dbPath);
    raw.run(`INSERT INTO webhook_meta (key, value) VALUES ('failover:active_harness', x'00')`);
    raw.close();

    const queue = new WebhookQueue({ dbPath });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      // A corrupt persisted row must not reject startup.
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode,grok",
        queue,
        log: () => {},
      });
    } finally {
      console.warn = originalWarn;
      queue.close();
      resetWorkerFailover();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(
      warnings.some((line) => line.includes("Could not restore persisted active harness")),
    ).toBe(true);
  });

  test("keeps healthy persisted rate-limit windows when the active harness is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-corrupt-active-"));
    const dbPath = join(dir, "queue.db");
    const seed = new WebhookQueue({ dbPath });
    seed.setRateLimit("grok", Date.now() + 60_000);
    seed.close();

    const { Database } = require("bun:sqlite");
    const raw = new Database(dbPath);
    raw.run(`INSERT INTO webhook_meta (key, value) VALUES ('failover:active_harness', x'00')`);
    raw.close();

    const queue = new WebhookQueue({ dbPath });
    const originalWarn = console.warn;
    try {
      console.warn = () => {};
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode,grok",
        queue,
        log: () => {},
      });
      expect(getWorkerFailover()?.manager.isLimited("grok")).toBe(true);
    } finally {
      console.warn = originalWarn;
      queue.close();
      resetWorkerFailover();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("usage-limit hint file", () => {
  test("round-trips untilMs and the reset hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-hint-"));
    const path = join(dir, "hint.json");
    const previous = process.env[USAGE_LIMIT_FILE_ENV];
    process.env[USAGE_LIMIT_FILE_ENV] = path;
    try {
      writeUsageLimitHint(new UsageLimitError("2h", "monthly"));
      const hint = readUsageLimitHint(path);
      expect(hint.resetsAt).toBe("2h");
      expect(hint.period).toBe("monthly");
      expect(hint.untilMs).toBeGreaterThan(Date.now());

      // No reset time: the child leaves the window to the parent's fallback.
      writeUsageLimitHint(new UsageLimitError(undefined, "monthly"));
      expect(readUsageLimitHint(path)).toEqual({ period: "monthly" });
    } finally {
      if (previous === undefined) {
        delete process.env[USAGE_LIMIT_FILE_ENV];
      } else {
        process.env[USAGE_LIMIT_FILE_ENV] = previous;
      }
    }
  });
});

describe("usage limit without a reset time", () => {
  const HOUR = 3_600_000;

  function singleHarness(now: () => number) {
    return new WorkerFailover({ checkInstalled: false, raw: "opencode", log: () => {}, now });
  }

  function windowMs(outcome: ReturnType<WorkerFailover["reportFromHint"]>, now: number): number {
    if (outcome.kind !== "exhausted") throw new Error(`expected exhausted, got ${outcome.kind}`);
    return outcome.untilMs - now;
  }

  test("doubles the fallback per consecutive limit and caps it at a day", () => {
    const now = Date.now();
    const failover = singleHarness(() => now);
    try {
      const windows = [1, 2, 3, 4, 5, 6, 7].map(() => windowMs(failover.reportFromHint({}), now));
      expect(windows).toEqual([1, 2, 4, 8, 16, 24, 24].map((hours) => hours * HOUR));
    } finally {
      failover.stop();
    }
  });

  test("a named quota period sets a floor on the first limit", () => {
    const now = Date.now();
    for (const [period, hours] of [
      ["monthly", 24],
      ["weekly", 24],
      ["daily", 4],
    ] as const) {
      const failover = singleHarness(() => now);
      try {
        expect(windowMs(failover.reportFromHint({ period }), now)).toBe(hours * HOUR);
      } finally {
        failover.stop();
      }
    }
  });

  test("a known reset time or a successful run restarts the backoff", () => {
    const now = Date.now();
    const logs: string[] = [];
    const failover = new WorkerFailover({
      checkInstalled: false,
      raw: "opencode",
      log: (message) => logs.push(message),
      now: () => now,
    });
    const lastCooldown = () => logs.filter((line) => line.includes("re-checking in")).at(-1);
    try {
      failover.reportFromHint({});
      failover.reportFromHint({});
      expect(lastCooldown()).toContain("(2 in a row); re-checking in 2h");
      failover.reportFromHint({ resetsAt: "30m" });
      failover.reportFromHint({});
      expect(lastCooldown()).toContain("(1 in a row); re-checking in 1h");

      failover.reportFromHint({});
      failover.recordSuccess();
      failover.reportFromHint({});
      expect(lastCooldown()).toContain("(1 in a row); re-checking in 1h");
    } finally {
      failover.stop();
    }
  });
});

describe("startWorkerFailover restore", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("restoring windows that cover the whole chain calls onPause once", async () => {
    dir = mkdtempSync(join(tmpdir(), "failover-restore-"));
    const queue = new WebhookQueue({ dbPath: join(dir, "queue.db") });
    const untilMs = Date.now() + 6 * 24 * 60 * 60 * 1000;
    try {
      queue.setRateLimit("opencode", untilMs);
      const pauses: Array<{ untilMs: number; harness: string }> = [];
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode",
        queue,
        log: () => {},
        onPause: (info) => pauses.push(info),
      });
      expect(pauses).toEqual([{ untilMs, harness: "opencode" }]);
      expect(getWorkerFailover()?.allLimited()).toBe(true);
    } finally {
      resetWorkerFailover();
      queue.close();
    }
  });

  test("restoring a partially limited chain does not pause", async () => {
    dir = mkdtempSync(join(tmpdir(), "failover-restore-"));
    const queue = new WebhookQueue({ dbPath: join(dir, "queue.db") });
    try {
      queue.setRateLimit("opencode", Date.now() + 60_000);
      let pauses = 0;
      await startWorkerFailover({
        checkInstalled: false,
        sandboxName: "none",
        raw: "opencode,codex",
        queue,
        log: () => {},
        onPause: () => pauses++,
      });
      expect(pauses).toBe(0);
    } finally {
      resetWorkerFailover();
      queue.close();
    }
  });
});

describe("harnessChainBlockedUntil", () => {
  function fake(allLimited: boolean, windows: Record<string, number>): WorkerFailover {
    return { allLimited: () => allLimited, windows: () => windows } as unknown as WorkerFailover;
  }

  test("returns the earliest future window only while every harness is limited", () => {
    const now = 1_000;
    expect(harnessChainBlockedUntil(null, now)).toBeUndefined();
    expect(harnessChainBlockedUntil(fake(false, { a: 5_000 }), now)).toBeUndefined();
    expect(harnessChainBlockedUntil(fake(true, { a: 9_000, b: 5_000, c: 500 }), now)).toBe(5_000);
    expect(harnessChainBlockedUntil(fake(true, { a: 500 }), now)).toBeUndefined();
  });

  test("words the reason with the ISO resume time", () => {
    expect(harnessBlockedReason(Date.parse("2026-11-20T04:00:12.689Z"))).toBe(
      "no agent harness is available until 2026-11-20T04:00:12.689Z (usage limit)",
    );
  });
});
