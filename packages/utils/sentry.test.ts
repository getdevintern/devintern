import { afterEach, describe, expect, mock, test } from "bun:test";

const sentryCalls = {
  init: 0,
  captured: [] as Array<{ error: unknown; extra?: Record<string, unknown> }>,
  flushed: 0,
};

mock.module("@sentry/node", () => ({
  init: () => {
    sentryCalls.init += 1;
  },
  captureException: (error: unknown, hint?: { extra?: Record<string, unknown> }) => {
    sentryCalls.captured.push({ error, extra: hint?.extra });
  },
  flush: async () => {
    sentryCalls.flushed += 1;
    return true;
  },
}));

const { captureError, flushErrorTracking, initErrorTracking, setErrorTrackingEnabled } =
  await import("./src/sentry.ts");

const TEST_DSN = "https://public@example.sentry.io/42";

describe("initErrorTracking", () => {
  afterEach(() => {
    sentryCalls.init = 0;
    sentryCalls.captured = [];
    sentryCalls.flushed = 0;
    delete process.env.SENTRY_DISABLED;
  });

  test("no-ops without a DSN", async () => {
    initErrorTracking({});
    expect(sentryCalls.init).toBe(0);
    captureError(new Error("boom"));
    expect(sentryCalls.captured).toHaveLength(0);
    await flushErrorTracking();
    expect(sentryCalls.flushed).toBe(0);
  });

  test("no-ops with SENTRY_DISABLED=1", () => {
    process.env.SENTRY_DISABLED = "1";
    initErrorTracking({ dsn: TEST_DSN });
    expect(sentryCalls.init).toBe(0);
  });

  test("initializes with a DSN and forwards captures", async () => {
    initErrorTracking({ dsn: TEST_DSN, release: "code@1.0.0" });
    expect(sentryCalls.init).toBe(1);

    const error = new Error("boom");
    captureError(error, { task: "TASK-1" });
    expect(sentryCalls.captured).toHaveLength(1);
    expect(sentryCalls.captured[0]?.error).toBe(error);
    expect(sentryCalls.captured[0]?.extra).toEqual({ task: "TASK-1" });

    await flushErrorTracking();
    expect(sentryCalls.flushed).toBe(1);
  });

  test("isEnabled guard blocks captures when disabled", () => {
    let enabled = true;
    initErrorTracking({ dsn: TEST_DSN, isEnabled: () => enabled });
    captureError(new Error("sent"));
    expect(sentryCalls.captured).toHaveLength(1);

    enabled = false;
    captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(1);
  });

  test("setErrorTrackingEnabled flips the live guard", () => {
    initErrorTracking({ dsn: TEST_DSN });
    setErrorTrackingEnabled(false);
    captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(0);
  });
});
