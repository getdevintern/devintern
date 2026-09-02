import { describe, expect, mock, test } from "bun:test";

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
  test("initializes error tracking at most once per process", () => {
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
