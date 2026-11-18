import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_REPORT_ACTIVE_ENV,
  autoReportMessage,
  autoReportStage,
  isAutoReportEnabled,
  maybeAutoReportFailure,
} from "../src/lib/report/auto-report";
import type { AutoReportDeps } from "../src/lib/report/auto-report";
import {
  analyzeFailure,
  describeDefect,
  devInternFrames,
  resolveDevInternPackageRoot,
  sanitizeErrorMessage,
} from "../src/lib/report/failure-analysis";
import { listSpoolEntries } from "../src/lib/report/store";
import type { BugReportPayload } from "../src/lib/report/types";

const ROOT = "/opt/devintern-code";

/** A TypeError whose innermost frame is DevIntern's own code. */
function devInternTypeError(message = "Cannot read properties of undefined (reading 'summary')") {
  const error = new TypeError(message);
  error.stack = [
    `TypeError: ${message}`,
    `    at formatTaskDetails (${ROOT}/src/lib/task/formatter.ts:120:15)`,
    `    at async processTask (${ROOT}/src/lib/task/pipeline.ts:610:7)`,
    `    at ${ROOT}/node_modules/some-dep/index.js:1:1`,
    "    at processTicksAndRejections (native)",
  ].join("\n");
  return error;
}

let workdir: string;
let requests: BugReportPayload[];
let respond: () => Response;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "report-auto-"));
  requests = [];
  respond = () =>
    new Response(JSON.stringify({ id: "r-1", url: "https://devintern.com/reports/r-1" }));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function deps(overrides: Partial<AutoReportDeps> = {}): AutoReportDeps {
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as BugReportPayload);
    return respond();
  }) as typeof fetch;
  return {
    env: { DEVINTERN_AUTO_REPORT: "1" },
    configDir: workdir,
    cwd: workdir,
    identity: { signedIn: true, accessToken: "token" },
    packageRoot: ROOT,
    fetchImpl,
    now: () => new Date("2026-11-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("isAutoReportEnabled", () => {
  test("is off by default and accepts common truthy values", () => {
    expect(isAutoReportEnabled({})).toBe(false);
    expect(isAutoReportEnabled({ DEVINTERN_AUTO_REPORT: "0" })).toBe(false);
    expect(isAutoReportEnabled({ DEVINTERN_AUTO_REPORT: "false" })).toBe(false);
    for (const value of ["1", "true", "YES", "on"]) {
      expect(isAutoReportEnabled({ DEVINTERN_AUTO_REPORT: value })).toBe(true);
    }
  });
});

describe("analyzeFailure", () => {
  test("classifies a programming error in DevIntern code as a defect", () => {
    const analysis = analyzeFailure(devInternTypeError(), { packageRoot: ROOT });
    expect(analysis.verdict).toBe("defect");
    expect(analysis.errorName).toBe("TypeError");
    expect(analysis.frames).toEqual([
      { fn: "formatTaskDetails", file: "src/lib/task/formatter.ts", line: 120 },
      { fn: "processTask", file: "src/lib/task/pipeline.ts", line: 610 },
    ]);
    expect(analysis.signature).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("gives the same signature for the same defect", () => {
    const a = analyzeFailure(devInternTypeError(), { packageRoot: ROOT });
    const b = analyzeFailure(devInternTypeError(), { packageRoot: ROOT });
    expect(a.signature).toBe(b.signature);
  });

  test("treats task and environment errors as not attributable", () => {
    const usage = new Error("limit");
    usage.name = "UsageLimitError";
    const http = Object.assign(new Error("boom"), { status: 404 });
    for (const error of [
      usage,
      http,
      new TypeError("fetch failed"),
      new Error("Jira API error 401: Unauthorized"),
      new Error("claude exited with code 1"),
      new Error("Merge conflict in src/app.ts"),
    ]) {
      expect(analyzeFailure(error, { packageRoot: ROOT }).verdict).toBe("task");
    }
  });

  test("is inconclusive for plain errors and errors raised outside DevIntern", () => {
    expect(analyzeFailure(new Error("something odd"), { packageRoot: ROOT }).verdict).toBe(
      "inconclusive",
    );
    expect(analyzeFailure("string thrown", { packageRoot: ROOT }).verdict).toBe("inconclusive");
    const dependency = new TypeError("x is not a function");
    dependency.stack = [
      "TypeError: x is not a function",
      `    at handler (${ROOT}/node_modules/dep/index.js:3:9)`,
      `    at run (${ROOT}/src/lib/task/pipeline.ts:10:1)`,
    ].join("\n");
    expect(analyzeFailure(dependency, { packageRoot: ROOT }).verdict).toBe("inconclusive");
    const userCode = new TypeError("x is not a function");
    userCode.stack = "TypeError: x\n    at hook (/home/me/project/plugin.ts:1:1)";
    expect(analyzeFailure(userCode, { packageRoot: ROOT }).verdict).toBe("inconclusive");
  });

  test("attributes shared monorepo packages to DevIntern", () => {
    const { frames, innermostIsDevIntern } = devInternFrames(
      "TypeError: x\n    at parse (/repo/packages/task-trackers/src/jira/client.ts:5:2)",
      ROOT,
    );
    expect(innermostIsDevIntern).toBe(true);
    expect(frames[0]?.file).toBe("task-trackers/src/jira/client.ts");
  });

  test("finds this package's root", () => {
    expect(resolveDevInternPackageRoot()).toBe(join(import.meta.dir, ".."));
  });
});

describe("sanitizeErrorMessage", () => {
  test("drops quoted free text, task keys, emails, and paths but keeps identifiers", () => {
    const message = sanitizeErrorMessage(
      `Cannot read 'summary' of "Fix the login page for ACME" in ${workdir}/x.ts for PROJ-12 by a@b.co`,
      { cwd: workdir },
    );
    expect(message).toContain("'summary'");
    expect(message).not.toContain("ACME");
    expect(message).not.toContain("PROJ-12");
    expect(message).not.toContain("a@b.co");
    expect(message).not.toContain(workdir);
  });

  test("keeps only the first line", () => {
    expect(sanitizeErrorMessage("first\nsecond line with secrets")).toBe("first");
  });
});

describe("maybeAutoReportFailure", () => {
  test("does nothing when disabled", async () => {
    const outcome = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({ env: {} }),
    );
    expect(outcome.status).toBe("disabled");
    expect(requests).toHaveLength(0);
    expect(listSpoolEntries(join(workdir, "reports"))).toHaveLength(0);
    expect(autoReportStage(outcome)).toBeNull();
    expect(autoReportMessage(outcome)).toBeNull();
  });

  test("does not submit task failures or inconclusive findings", async () => {
    const task = await maybeAutoReportFailure({ error: new Error("401 Unauthorized") }, deps());
    const unclear = await maybeAutoReportFailure({ error: new Error("weird") }, deps());
    expect(task.status).toBe("not_reported");
    expect(unclear.status).toBe("not_reported");
    expect(requests).toHaveLength(0);
    expect(autoReportStage(task)?.status).toBe("skipped");
  });

  test("submits a privacy-conscious report for a DevIntern defect", async () => {
    const outcome = await maybeAutoReportFailure(
      {
        error: devInternTypeError(`Cannot read 'summary' of "Secret ticket title" for PROJ-7`),
        taskKey: "PROJ-7",
        failedStep: "implementation",
        cliVersion: "1.2.3",
      },
      deps(),
    );
    expect(outcome).toMatchObject({
      status: "reported",
      reportId: "r-1",
      url: "https://devintern.com/reports/r-1",
    });
    expect(requests).toHaveLength(1);
    const payload = requests[0]!;
    const serialized = JSON.stringify(payload);
    expect(payload.title.startsWith("[auto] TypeError in formatTaskDetails")).toBe(true);
    expect(payload.description).toContain("src/lib/task/formatter.ts:120");
    expect(payload.description).toContain("Failed step: implementation");
    expect(payload.context?.logs).toBeUndefined();
    expect(payload.context?.run).toBeUndefined();
    expect(serialized).not.toContain("Secret ticket title");
    expect(serialized).not.toContain("PROJ-7");
    expect(serialized).not.toContain(workdir);
    expect(serialized).not.toContain("token");
    expect(payload.environment.cliVersion).toBe("1.2.3");

    const stage = autoReportStage(outcome);
    expect(stage?.status).toBe("succeeded");
    expect(stage?.detail.url).toBe("https://devintern.com/reports/r-1");
    expect(autoReportMessage(outcome)).toContain("https://devintern.com/reports/r-1");
    expect(listSpoolEntries(join(workdir, "reports"))[0]?.status).toBe("submitted");
  });

  test("links an already-reported defect instead of sending it again", async () => {
    await maybeAutoReportFailure({ error: devInternTypeError() }, deps());
    const second = await maybeAutoReportFailure({ error: devInternTypeError() }, deps());
    expect(second).toMatchObject({ status: "duplicate", url: "https://devintern.com/reports/r-1" });
    expect(requests).toHaveLength(1);
  });

  test("preserves the report locally when submission fails and resends it later", async () => {
    respond = () => new Response(JSON.stringify({ error: "down" }), { status: 503 });
    const failed = await maybeAutoReportFailure({ error: devInternTypeError() }, deps());
    expect(failed.status).toBe("submit_failed");
    expect(autoReportStage(failed)?.status).toBe("failed");
    expect(autoReportMessage(failed)).toContain("devintern report --from");

    respond = () => new Response(JSON.stringify({ id: "r-2" }));
    const retried = await maybeAutoReportFailure({ error: devInternTypeError() }, deps());
    expect(retried.status).toBe("reported");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.reportId).toBe(requests[0]!.reportId);
    expect(listSpoolEntries(join(workdir, "reports"))).toHaveLength(1);
  });

  test("needs a sign-in or contact email for anonymous reports", async () => {
    const anonymous = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({ identity: { signedIn: false } }),
    );
    expect(anonymous.status).toBe("no_contact");
    expect(requests).toHaveLength(0);

    const withEmail = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({
        identity: { signedIn: false },
        env: { DEVINTERN_AUTO_REPORT: "1", DEVINTERN_REPORT_EMAIL: "ops@example.com" },
      }),
    );
    expect(withEmail.status).toBe("reported");
    expect(requests[0]?.contact?.email).toBe("ops@example.com");
  });

  test("never recurses and never throws", async () => {
    const nested = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({ env: { DEVINTERN_AUTO_REPORT: "1", [AUTO_REPORT_ACTIVE_ENV]: "1" } }),
    );
    expect(nested.status).toBe("recursive");

    const env: NodeJS.ProcessEnv = { DEVINTERN_AUTO_REPORT: "1" };
    const broken = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({
        env,
        createReporter: () => {
          throw new Error("reporter exploded");
        },
      }),
    );
    expect(broken).toEqual({ status: "error", error: "reporter exploded" });
    expect(env[AUTO_REPORT_ACTIVE_ENV]).toBeUndefined();
  });

  test("gives up after the timeout and releases the guard after a grace period", async () => {
    const env: NodeJS.ProcessEnv = { DEVINTERN_AUTO_REPORT: "1" };
    const outcome = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({
        env,
        timeoutMs: 20,
        // Ignores the abort signal and never settles.
        fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      }),
    );
    expect(outcome.status).toBe("error");
    expect(env[AUTO_REPORT_ACTIVE_ENV]).toBe("1");
    await Bun.sleep(60);
    expect(env[AUTO_REPORT_ACTIVE_ENV]).toBeUndefined();
  });
});

describe("analyzeFailure in the published bundle", () => {
  const INSTALLED = "/usr/lib/node_modules/@getdevintern/code";

  function stackError(
    frames: string[],
    message = "undefined is not an object (evaluating 'e.a.b')",
  ) {
    const error = new TypeError(message);
    error.stack = [`TypeError: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join("\n");
    return error;
  }

  test("is inconclusive when frames still point at the unmapped bundle", () => {
    const error = stackError([
      `Kq (${INSTALLED}/dist/index.js:812:4410)`,
      `zR (${INSTALLED}/dist/index.js:1990:12)`,
    ]);
    const analysis = analyzeFailure(error, { packageRoot: INSTALLED });
    expect(analysis.verdict).toBe("inconclusive");
    expect(analysis.rationale).toContain("source map");
  });

  test("attributes source-mapped frames and drops minified names", () => {
    const error = stackError([
      `Kq (${INSTALLED}/src/lib/task/formatter.ts:120:15)`,
      `zR (${INSTALLED}/src/lib/task/pipeline.ts:610:7)`,
    ]);
    const analysis = analyzeFailure(error, { packageRoot: INSTALLED, minifiedNames: true });
    expect(analysis.verdict).toBe("defect");
    expect(analysis.frames).toEqual([
      { file: "src/lib/task/formatter.ts", line: 120 },
      { file: "src/lib/task/pipeline.ts", line: 610 },
    ]);
    const { title, description } = describeDefect(analysis, { cliVersion: "2.25.0" });
    expect(title).toContain("src/lib/task/formatter.ts");
    expect(description).not.toContain("Kq");
    expect(description).toContain("DevIntern version: 2.25.0");
  });

  test("treats source-mapped vendored dependencies as outside DevIntern", () => {
    // `../../../node_modules/<dep>` in the map, resolved from the installed dist/.
    const error = stackError([
      "turndown (/usr/lib/node_modules/node_modules/turndown/lib/turndown.es.js:613:17)",
      `zR (${INSTALLED}/src/lib/task/formatter.ts:120:15)`,
    ]);
    expect(analyzeFailure(error, { packageRoot: INSTALLED }).verdict).toBe("inconclusive");
  });

  test("attributes bundled shared packages mapped next to the package root", () => {
    const error = stackError([
      "Yx (/usr/lib/node_modules/@getdevintern/utils/src/fetch-with-retry.ts:40:3)",
      `zR (${INSTALLED}/src/lib/task/formatter.ts:120:15)`,
    ]);
    const analysis = analyzeFailure(error, { packageRoot: INSTALLED, minifiedNames: true });
    expect(analysis.verdict).toBe("defect");
    expect(analysis.frames?.[0]).toEqual({ file: "utils/src/fetch-with-retry.ts", line: 40 });
  });

  test("keeps the signature stable across releases", () => {
    const before = stackError(
      [`Kq (${INSTALLED}/src/lib/task/formatter.ts:120:15)`],
      "undefined is not an object (evaluating 'e.a.b')",
    );
    const after = stackError(
      [`Wv (${INSTALLED}/src/lib/task/formatter.ts:131:9)`],
      "undefined is not an object (evaluating 'r.a.b')",
    );
    const options = { packageRoot: INSTALLED, minifiedNames: true, failedStep: "implementation" };
    expect(analyzeFailure(before, options).signature).toBe(
      analyzeFailure(after, options).signature,
    );

    const elsewhere = stackError([`Kq (${INSTALLED}/src/lib/task/pipeline.ts:120:15)`]);
    expect(analyzeFailure(elsewhere, options).signature).not.toBe(
      analyzeFailure(before, options).signature,
    );
  });
});

describe("analyzeFailure message filters", () => {
  test("does not mistake identifiers in programming errors for task failures", () => {
    for (const message of [
      "x.timeout is not a function",
      "timeout is not a function",
      "undefined is not an object (evaluating 'res.notFound.rejected')",
      "Cannot read properties of undefined (reading 'isRequired')",
    ]) {
      expect(analyzeFailure(devInternTypeError(message), { packageRoot: ROOT }).verdict).toBe(
        "defect",
      );
    }
  });

  test("still treats environment prose in programming errors as task failures", () => {
    expect(analyzeFailure(new TypeError("fetch failed"), { packageRoot: ROOT }).verdict).toBe(
      "task",
    );
    expect(
      analyzeFailure(devInternTypeError("Request timed out after 30s"), { packageRoot: ROOT })
        .verdict,
    ).toBe("task");
  });
});

describe("maybeAutoReportFailure timeout", () => {
  test("aborts the in-flight submission and keeps the guard until it settles", async () => {
    let aborted = false;
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const env: NodeJS.ProcessEnv = { DEVINTERN_AUTO_REPORT: "1" };
    const hanging = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          // Settle a moment later, like a real socket teardown.
          setTimeout(() => {
            reject(new Error("aborted"));
            setTimeout(() => settle?.(), 0);
          }, 30);
        });
      })) as unknown as typeof fetch;

    const outcome = await maybeAutoReportFailure(
      { error: devInternTypeError() },
      deps({ env, timeoutMs: 20, fetchImpl: hanging }),
    );
    expect(outcome).toEqual({ status: "error", error: "timed out after 20 ms" });
    expect(aborted).toBe(true);
    // The abandoned attempt is still winding down: a new failure must not start another.
    expect(env[AUTO_REPORT_ACTIVE_ENV]).toBe("1");
    expect(
      (await maybeAutoReportFailure({ error: devInternTypeError() }, deps({ env }))).status,
    ).toBe("recursive");

    await settled;
    await Bun.sleep(5);
    expect(env[AUTO_REPORT_ACTIVE_ENV]).toBeUndefined();
  });
});

describe("describeDefect", () => {
  test("omits task content and keeps DevIntern facts", () => {
    const analysis = analyzeFailure(devInternTypeError(), { packageRoot: ROOT });
    const { title, description } = describeDefect(analysis, { failedStep: "verify" });
    expect(title.length).toBeLessThanOrEqual(200);
    expect(description).toContain("formatTaskDetails (src/lib/task/formatter.ts:120)");
    expect(description).not.toContain("node_modules");
  });
});
