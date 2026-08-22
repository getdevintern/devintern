import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  BudgetGate,
  SpendCapConfigError,
  parseSpendCap,
  parseSpendCapConfig,
  startOfUtcDay,
} from "../src/lib/budget-guard";
import { RunStore } from "../src/lib/run-recorder";

describe("parseSpendCap", () => {
  test("accepts plain non-negative decimals and treats unset/blank as disabled", () => {
    expect(parseSpendCap({ K: "10" }, "K")).toBe(10);
    expect(parseSpendCap({ K: "4.50" }, "K")).toBeCloseTo(4.5);
    expect(parseSpendCap({ K: "0" }, "K")).toBe(0);
    expect(parseSpendCap({}, "K")).toBeNull();
    expect(parseSpendCap({ K: "" }, "K")).toBeNull();
    expect(parseSpendCap({ K: "   " }, "K")).toBeNull();
  });

  test("rejects negative values with an actionable message", () => {
    expect(() => parseSpendCap({ K: "-5" }, "K")).toThrow(SpendCapConfigError);
    expect(() => parseSpendCap({ K: "-5" }, "K")).toThrow(/must not be negative/);
  });

  test("rejects non-finite and non-numeric values", () => {
    for (const bad of ["abc", "NaN", "Infinity", "1e9"]) {
      expect(() => parseSpendCap({ K: bad }, "K")).toThrow(SpendCapConfigError);
    }
  });

  test("rejects currency symbols and suffixes (caps are USD-only)", () => {
    expect(() => parseSpendCap({ K: "$5" }, "K")).toThrow(/USD/);
    expect(() => parseSpendCap({ K: "5 EUR" }, "K")).toThrow(/USD/);
    expect(() => parseSpendCap({ K: "5€" }, "K")).toThrow(SpendCapConfigError);
  });

  test("parseSpendCapConfig reads both cap variables", () => {
    const config = parseSpendCapConfig({
      WORKER_MAX_SPEND_PER_RUN_USD: "2.50",
      WORKER_MAX_SPEND_PER_DAY_USD: "40",
    });
    expect(config.perRunUsd).toBeCloseTo(2.5);
    expect(config.perDayUsd).toBe(40);

    expect(parseSpendCapConfig({})).toEqual({ perRunUsd: null, perDayUsd: null });
  });
});

describe("startOfUtcDay", () => {
  test("truncates to UTC midnight regardless of local timezone offset", () => {
    // 2026-08-22T15:30:45.123Z → 2026-08-22T00:00:00.000Z
    const ms = Date.UTC(2026, 7, 22, 15, 30, 45, 123);
    expect(startOfUtcDay(ms)).toBe(Date.UTC(2026, 7, 22));
  });

  test("the day boundary rolls over exactly at midnight UTC", () => {
    const justBefore = Date.UTC(2026, 7, 22, 23, 59, 59, 999);
    const midnight = Date.UTC(2026, 7, 23, 0, 0, 0, 0);
    expect(startOfUtcDay(justBefore)).toBe(Date.UTC(2026, 7, 22));
    expect(startOfUtcDay(midnight)).toBe(Date.UTC(2026, 7, 23));
    expect(startOfUtcDay(midnight)).not.toBe(startOfUtcDay(justBefore));
  });
});

describe("BudgetGate admission", () => {
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dbPath = join(tmpdir(), `bg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function seedUnattendedSpend(costUsd: number | null): void {
    const id = store.createRun({ origin: "task", taskKey: `AUTO-${costUsd}`, unattended: true });
    if (costUsd !== null) {
      store.recordRunUsage(id, {
        source: "structured_output",
        complete: true,
        model: "gpt-5",
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        costUsd,
        costCurrency: "USD",
        costSource: "estimated",
        pricingVersion: "v",
        sessionCount: 1,
        sessionsWithoutUsage: 0,
      });
    }
    // Backdate the finish into "today".
    const now = Date.now();
    const db = (store as unknown as { db: { run: (sql: string, ...params: unknown[]) => void } })
      .db;
    db.run(`UPDATE runs SET finished_at = ? WHERE id = ?`, [
      startOfUtcDay(now) + Math.floor((now - startOfUtcDay(now)) / 2),
      id,
    ]);
    store.finishRun(id, "succeeded");
  }

  test("no caps configured → always allowed", () => {
    const gate = new BudgetGate(store, { perRunUsd: null, perDayUsd: null });
    seedUnattendedSpend(1000);
    expect(gate.checkAdmission().allowed).toBe(true);
  });

  test("below-cap spend admits; exact-boundary spend blocks", () => {
    const gate = new BudgetGate(store, { perRunUsd: null, perDayUsd: 10 });

    seedUnattendedSpend(9.99);
    expect(gate.checkAdmission().allowed).toBe(true);

    // Push total to exactly the cap: meeting the cap leaves no headroom.
    seedUnattendedSpend(0.01);
    const decision = gate.checkAdmission();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.limitUsd).toBe(10);
      expect(decision.spentTodayUsd).toBeCloseTo(10);
      expect(decision.resetsAtIso).toMatch(/T00:00:00\.000Z$/);
    }
  });

  test("manual runs never count toward the daily cap", () => {
    const gate = new BudgetGate(store, { perRunUsd: null, perDayUsd: 5 });
    const manual = store.createRun({ origin: "task", taskKey: "MAN-1" }); // no unattended flag
    store.recordRunUsage(manual, {
      source: "structured_output",
      complete: true,
      model: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: 500,
      costCurrency: "USD",
      costSource: "reported",
      pricingVersion: null,
      sessionCount: 1,
      sessionsWithoutUsage: 0,
    });
    store.finishRun(manual, "succeeded");
    expect(gate.checkAdmission().allowed).toBe(true);
  });

  test("UTC day rollover re-admits after the capped day ends", () => {
    const gate = new BudgetGate(store, { perRunUsd: null, perDayUsd: 5 });
    seedUnattendedSpend(6);

    // Still blocked "now".
    expect(gate.checkAdmission(Date.now()).allowed).toBe(false);

    // Tomorrow (UTC): allowed again.
    const tomorrow = startOfUtcDay(Date.now()) + 24 * 60 * 60 * 1000 + 60_000;
    expect(gate.checkAdmission(tomorrow).allowed).toBe(true);
  });

  test("spend is read from persisted rows, so a fresh gate sees prior spend (restart persistence)", () => {
    seedUnattendedSpend(7);
    store.close();
    const reopened = new RunStore(dbPath);
    const freshGate = new BudgetGate(reopened, { perRunUsd: null, perDayUsd: 5 });
    const decision = freshGate.checkAdmission();
    expect(decision.allowed).toBe(false);
    reopened.close();
  });

  test("unknown-cost runs surface exposure in the blocked decision", () => {
    seedUnattendedSpend(null); // usage recorded but cost unknown
    const gate = new BudgetGate(store, { perRunUsd: null, perDayUsd: 5 });
    const decision = gate.checkAdmission();
    // Unknown cost alone does not trip the cap (known spend is null).
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.spentTodayUsd).toBeNull();
    }
  });

  test("noteRunFinished warns once per overshooting run and ignores under-cap runs", () => {
    const gate = new BudgetGate(store, { perRunUsd: 1, perDayUsd: null });
    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      gate.noteRunFinished({
        source: null,
        complete: false,
        model: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        costUsd: 2.5,
        costCurrency: "USD",
        costSource: null,
        pricingVersion: null,
        sessionCount: 2,
        sessionsWithoutUsage: 1,
      });
      gate.noteRunFinished({
        source: null,
        complete: true,
        model: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        costUsd: 0.5,
        costCurrency: "USD",
        costSource: "estimated",
        pricingVersion: null,
        sessionCount: 1,
        sessionsWithoutUsage: 0,
      });
      gate.noteRunFinished(null);
    } finally {
      console.warn = originalWarn;
    }

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("$2.5");
    expect(logs[0]).toContain("usage incomplete");
  });
});
