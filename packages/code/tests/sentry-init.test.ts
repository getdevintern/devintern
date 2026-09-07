import { afterEach, describe, expect, mock, test } from "bun:test";

const sentryCalls = {
  init: 0,
  initOpts: [] as Array<{ release?: string; environment?: string }>,
};

mock.module("@sentry/node", () => ({
  init: (opts: { release?: string; environment?: string }) => {
    sentryCalls.init += 1;
    sentryCalls.initOpts.push(opts);
  },
  captureException: () => undefined,
  flush: async () => true,
}));

const { initSentryOnce } = await import("../src/lib/sentry-init.ts");

describe("initSentryOnce", () => {
  afterEach(() => {
    process.env.SENTRY_DISABLED = "1";
  });

  test("initializes error tracking at most once per process", () => {
    // guard-sentry.ts preloads SENTRY_DISABLED=1 across the suite; lift it
    // here so initErrorTracking proceeds (no real DSN traffic happens —
    // @sentry/node is mocked above). Restored in afterEach.
    delete process.env.SENTRY_DISABLED;

    // Repeated calls (CLI shell, worker, webhook all run through this in one
    // process) must not re-initialize or double-report.
    initSentryOnce("code@1.2.3");
    initSentryOnce("code@1.2.3");
    initSentryOnce();

    expect(sentryCalls.init).toBe(1);
    expect(sentryCalls.initOpts[0]?.release).toBe("code@1.2.3");
    expect(sentryCalls.initOpts[0]?.environment).toBe(process.env.NODE_ENV ?? "production");
  });
});
