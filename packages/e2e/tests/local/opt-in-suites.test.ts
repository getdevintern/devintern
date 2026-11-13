import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPT_IN_SUITES, optInSuiteCommand } from "../../helpers/opt-in-suites";

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const packageScripts = packageJson.scripts ?? {};

describe("opt-in e2e suites (not run by `test`)", () => {
  test("every implemented opt-in suite has a package script", () => {
    const missing = OPT_IN_SUITES.filter(
      (suite) => suite.status === "skip" && !packageScripts[suite.script],
    ).map((suite) => suite.script);
    expect(missing).toEqual([]);
  });

  for (const suite of OPT_IN_SUITES) {
    const command = packageScripts[suite.script] ? `; run ${optInSuiteCommand(suite.script)}` : "";
    if (suite.status === "todo") {
      test.todo(`${suite.name} — ${suite.reason}${command}`, () => {
        throw new Error("Planned coverage; see docs/tracker-e2e-plan.md");
      });
      continue;
    }
    test.skip(`${suite.name} — ${suite.reason}${command}`, () => {});
  }
});
