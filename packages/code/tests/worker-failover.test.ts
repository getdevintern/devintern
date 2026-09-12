import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { UsageLimitError } from "@devintern/agent-harness";

import { WebhookQueue } from "../src/lib/state/webhook-queue";
import {
  resetWorkerFailover,
  runWithFailover,
  startWorkerFailover,
} from "../src/lib/worker-failover";
import {
  readUsageLimitHint,
  USAGE_LIMIT_EXIT_CODE,
  USAGE_LIMIT_FILE_ENV,
  writeUsageLimitHint,
} from "../src/lib/usage-limit-protocol";

afterEach(() => {
  resetWorkerFailover();
});

describe("runWithFailover", () => {
  test("without a worker controller, a usage-limit exit is a plain failure", async () => {
    const result = await runWithFailover(async () => USAGE_LIMIT_EXIT_CODE);
    expect(result).toBe("failed");
  });

  test("retries the same spawn on the next harness after exit 75", async () => {
    startWorkerFailover({ checkInstalled: false, raw: "codex,grok", log: () => {} });

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

  test("returns deferred when every harness in the chain is limited", async () => {
    startWorkerFailover({ checkInstalled: false, raw: "codex,grok", log: () => {} });

    const result = await runWithFailover(async (env) => {
      writeFileSync(env[USAGE_LIMIT_FILE_ENV]!, JSON.stringify({ untilMs: Date.now() + 60_000 }));
      return USAGE_LIMIT_EXIT_CODE;
    });

    expect(result).toBe("deferred");
  });

  test("pins AGENT_HARNESS to the active entry on the first attempt", async () => {
    startWorkerFailover({ checkInstalled: false, raw: "codex,grok,cursor", log: () => {} });

    const result = await runWithFailover(async (env) => {
      expect(env.AGENT_HARNESS).toBe("codex");
      expect(env.DEVINTERN_WORKER_CHILD).toBe("1");
      return 0;
    });
    expect(result).toBe("ok");
  });
});

describe("worker startup with a stale persisted active harness", () => {
  test("the selected fallback is persisted so the next start does not re-warn", () => {
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
      startWorkerFailover({
        checkInstalled: false,
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
      startWorkerFailover({
        checkInstalled: false,
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

describe("usage-limit hint file", () => {
  test("round-trips untilMs and the reset hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "devintern-hint-"));
    const path = join(dir, "hint.json");
    const previous = process.env[USAGE_LIMIT_FILE_ENV];
    process.env[USAGE_LIMIT_FILE_ENV] = path;
    try {
      writeUsageLimitHint(new UsageLimitError("4:27 PM"));
      const hint = readUsageLimitHint(path);
      expect(hint.resetsAt).toBe("4:27 PM");
      expect(hint.untilMs).toBeGreaterThan(Date.now());
    } finally {
      if (previous === undefined) {
        delete process.env[USAGE_LIMIT_FILE_ENV];
      } else {
        process.env[USAGE_LIMIT_FILE_ENV] = previous;
      }
    }
  });
});
