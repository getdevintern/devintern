import { afterEach, describe, expect, mock, test } from "bun:test";

const sentryCalls = {
  init: 0,
  initOpts: undefined as
    | {
        beforeSend?: (event: Record<string, unknown>) => unknown;
      }
    | undefined,
  captured: [] as Array<{ error: unknown; extra?: Record<string, unknown> }>,
  flushed: 0,
};

mock.module("@sentry/node", () => ({
  init: (opts: typeof sentryCalls.initOpts) => {
    sentryCalls.init += 1;
    sentryCalls.initOpts = opts;
  },
  captureException: (error: unknown, hint?: { extra?: Record<string, unknown> }) => {
    sentryCalls.captured.push({ error, extra: hint?.extra });
  },
  flush: async () => {
    sentryCalls.flushed += 1;
    return true;
  },
}));

const {
  captureError,
  DEVINTERN_SENTRY_DSN,
  flushErrorTracking,
  initErrorTracking,
  setErrorTrackingEnabled,
} = await import("./src/sentry.ts");
const { REDACTED, redactText, redactValue } = await import("./src/redact.ts");

describe("initErrorTracking", () => {
  afterEach(() => {
    sentryCalls.init = 0;
    sentryCalls.initOpts = undefined;
    sentryCalls.captured = [];
    sentryCalls.flushed = 0;
    delete process.env.SENTRY_DISABLED;
  });

  test("no-ops with SENTRY_DISABLED=1", () => {
    process.env.SENTRY_DISABLED = "1";
    initErrorTracking({});
    expect(sentryCalls.init).toBe(0);
  });

  test("initializes with the baked-in DSN and forwards captures", async () => {
    initErrorTracking({ release: "code@1.0.0" });
    expect(DEVINTERN_SENTRY_DSN.length).toBeGreaterThan(0);
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
    initErrorTracking({ isEnabled: () => enabled });
    captureError(new Error("sent"));
    expect(sentryCalls.captured).toHaveLength(1);

    enabled = false;
    captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(1);
  });

  test("setErrorTrackingEnabled flips the live guard", () => {
    initErrorTracking({});
    setErrorTrackingEnabled(false);
    captureError(new Error("blocked"));
    expect(sentryCalls.captured).toHaveLength(0);
  });

  test("redacts secrets from events via beforeSend", () => {
    initErrorTracking({});

    const token = "ghp_" + "a".repeat(36);
    const beforeSend = sentryCalls.initOpts?.beforeSend;
    expect(beforeSend).toBeTypeOf("function");

    const event = beforeSend!({
      extra: {
        taskKey: "TASK-1",
        apiToken: "super-secret-value",
        nested: { password: "hunter2", url: "https://user:pw@example.com/x" },
      },
      message: `GitHub API rejected ${token} for GET /repo`,
      exception: { values: [{ value: `auth failed for ${token}` }] },
    });

    expect(event.extra).toEqual({
      taskKey: "TASK-1",
      apiToken: REDACTED,
      nested: { password: REDACTED, url: `https://${REDACTED}@example.com/x` },
    });
    expect(event.message).not.toContain(token);
    expect(event.message).toContain(REDACTED);
    expect(
      (event as { exception: { values: Array<{ value: string }> } }).exception.values[0].value,
    ).toBe(`auth failed for ${REDACTED}`);
  });
});

describe("redact", () => {
  test("redactText scrubs known token shapes and query credentials", () => {
    expect(redactText("token ghp_" + "a".repeat(36) + " end")).toBe(`token ${REDACTED} end`);
    expect(redactText("Bearer abcdef123456")).toBe(`Bearer ${REDACTED}`);
    expect(redactText("https://user:secret@example.com")).toBe(`https://${REDACTED}@example.com`);
    expect(redactText("https://api.test/v1?token=abc123&ok=1")).toBe(
      `https://api.test/v1?token=${REDACTED}&ok=1`,
    );
    // Ordinary text survives untouched.
    expect(redactText("Agent exited with code 1")).toBe("Agent exited with code 1");
  });

  test("redactValue drops secret-shaped keys recursively", () => {
    expect(
      redactValue({
        taskKey: "TASK-2",
        auth: { authorization: "Bearer x", channel: "pm:create-task" },
        apiKey: "k".repeat(40),
      }),
    ).toEqual({
      taskKey: "TASK-2",
      auth: { authorization: REDACTED, channel: "pm:create-task" },
      apiKey: REDACTED,
    });
  });
});
