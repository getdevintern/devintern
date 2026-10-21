import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseReportArgs } from "../src/lib/report/cli";

describe("report CLI parsing", () => {
  test("parses the common report flags", () => {
    const options = parseReportArgs([
      "--title",
      "Worker crash",
      "--body",
      "Steps",
      "--last",
      "--log",
      "a.log",
      "--log",
      "b.log",
      "--no-logs",
      "--no-diagnostics",
      "--share-identifiers",
      "--yes",
      "--json",
    ]);
    expect(options.title).toBe("Worker crash");
    expect(options.body).toBe("Steps");
    expect(options.last).toBe(true);
    expect(options.logPaths).toEqual(["a.log", "b.log"]);
    expect(options.logs).toBe(false);
    expect(options.diagnostics).toBe(false);
    expect(options.shareIdentifiers).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.json).toBe(true);
  });

  test("parses subcommands", () => {
    expect(parseReportArgs(["list"]).list).toBe(true);
    expect(parseReportArgs(["show", "abcd1234"]).show).toBe("abcd1234");
  });

  test("rejects missing and unknown values", () => {
    expect(() => parseReportArgs(["--title"])).toThrow("needs a value");
    expect(() => parseReportArgs(["--nope"])).toThrow("Unknown option");
    expect(() => parseReportArgs(["--run", "nope"])).toThrow("positive integer");
  });
});

describe("saved report consent", () => {
  test("refuses a non-interactive retry without --yes and still allows preview", () => {
    const workdir = mkdtempSync(join(tmpdir(), "report-consent-"));
    try {
      const path = join(workdir, "report.json");
      const payload = {
        schema: 1,
        reportId: "11111111-1111-1111-1111-111111111111",
        title: "Unexpected result",
        description: "Expected a change, but the run completed without one.",
        environment: {},
      };
      writeFileSync(path, JSON.stringify(payload));
      const run = (flags: string[]) =>
        spawnSync(
          process.execPath,
          [resolve(import.meta.dir, "../src/index.ts"), "report", "--from", path, ...flags],
          {
            cwd: workdir,
            encoding: "utf8",
            env: {
              ...process.env,
              SENTRY_DISABLED: "1",
              DEVINTERN_TELEMETRY_DISABLED: "1",
              DEVINTERN_WORKSPACE_DIR: join(workdir, "workspace"),
              DEVINTERN_REPORT_URL: "http://127.0.0.1:1/reports",
            },
            timeout: 10000,
          },
        );
      const retry = run([]);
      expect(retry.status).toBe(2);
      expect(retry.stderr).toContain("Refusing to submit without confirmation");
      expect(retry.stdout).toContain(payload.title);
      const jsonRetry = run(["--json"]);
      expect(jsonRetry.status).toBe(2);
      expect(jsonRetry.stderr).toContain("Refusing to submit without confirmation");
      const preview = run(["--print"]);
      expect(preview.status).toBe(0);
      expect(JSON.parse(preview.stdout)).toEqual(payload);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
