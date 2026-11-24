import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  deliveryRunDisposition,
  isBlockedOutcomeReason,
  isPreExistingOnBaseReason,
  OUTCOME_REASON_MAX_LENGTH,
  outcomeRunDisposition,
  parseImplementationOutcome,
} from "../src/lib/agent/implementation-outcome";
import { readImplementationReport } from "../src/lib/agent/implementation-report";
import { withImplementationSummary } from "../src/lib/agent/implementation-summary";
import {
  RUN_OUTCOME_FILE_ENV,
  readRunOutcomeHint,
  writeRunOutcomeHint,
} from "../src/lib/worker/run-outcome-protocol";

const summary = (body = "## Why\nRelease.") =>
  `<!-- devintern:summary:start -->\n${body}\n<!-- devintern:summary:end -->`;
const marker = (attrs: string) => `<!-- devintern:outcome ${attrs} -->`;

describe("parseImplementationOutcome", () => {
  test("reads a blocked marker placed after the summary", () => {
    const output = `Working...\n${summary()}\n${marker('status=blocked reason="unit test gate failed"')}\n`;
    expect(parseImplementationOutcome(output)).toEqual({
      status: "blocked",
      reason: "unit test gate failed",
    });
  });

  test("reads a marker inside the summary block", () => {
    const output = summary(`## Why\nx\n${marker('status=blocked reason="push refused"')}`);
    expect(parseImplementationOutcome(output)?.status).toBe("blocked");
  });

  test("accepts done, noop and partial, and a marker without a reason", () => {
    expect(parseImplementationOutcome(`${summary()}\n${marker("status=done")}`)).toEqual({
      status: "done",
    });
    expect(parseImplementationOutcome(`${summary()}\n${marker("status=noop")}`)?.status).toBe(
      "noop",
    );
    expect(
      parseImplementationOutcome(`${summary()}\n${marker('status=partial reason="half"')}`),
    ).toEqual({ status: "partial", reason: "half" });
  });

  test("returns undefined without a marker", () => {
    expect(parseImplementationOutcome(`Main is green, so I made no changes.\n${summary()}`)).toBe(
      undefined,
    );
  });

  test("ignores malformed markers", () => {
    for (const bad of [
      marker("status=BLOCKED"),
      marker("status=failed"),
      marker("status=blocked reason=unquoted"),
      marker('status=blocked reason="unterminated'),
      `${marker("status=blocked")} trailing text`,
      `Note: ${marker("status=blocked")}`,
      "<!-- devintern:outcome -->",
    ]) {
      expect(parseImplementationOutcome(`${summary()}\n${bad}`)).toBeUndefined();
    }
  });

  test("a malformed later marker does not discard an earlier valid one", () => {
    const output = `${summary()}\n${marker('status=blocked reason="gate"')}\n${marker("status=nope")}`;
    expect(parseImplementationOutcome(output)?.status).toBe("blocked");
  });

  test("the last valid marker wins", () => {
    const output = `${summary()}\n${marker('status=blocked reason="gate"')}\n${marker("status=done")}`;
    expect(parseImplementationOutcome(output)?.status).toBe("done");
  });

  test("ignores markers before the final summary block", () => {
    const output = `${summary("## Why\nfirst")}\n${marker('status=blocked reason="old"')}\n${summary("## Why\nfinal")}\n`;
    expect(parseImplementationOutcome(output)).toBeUndefined();
  });

  test("ignores markers quoted early in a long transcript without a summary", () => {
    const filler = Array.from({ length: 100 }, (_, index) => `progress line ${index}`).join("\n");
    const output = `${marker('status=blocked reason="quoted from the task"')}\n${filler}`;
    expect(parseImplementationOutcome(output)).toBeUndefined();
    expect(parseImplementationOutcome(`${filler}\n${marker("status=blocked")}`)?.status).toBe(
      "blocked",
    );
  });

  test("ignores markers inside code fences", () => {
    const output = `${summary()}\n\`\`\`\n${marker('status=blocked reason="example"')}\n\`\`\`\n`;
    expect(parseImplementationOutcome(output)).toBeUndefined();
  });

  test("bounds and sanitizes the reason", () => {
    const long = "x".repeat(OUTCOME_REASON_MAX_LENGTH * 3);
    const parsed = parseImplementationOutcome(
      `${summary()}\n${marker(`status=blocked reason="${long}"`)}`,
    );
    expect(parsed?.reason?.length).toBe(OUTCOME_REASON_MAX_LENGTH);
    const spaced = parseImplementationOutcome(
      `${summary()}\n${marker('status=blocked reason="  a\tb   c  "')}`,
    );
    expect(spaced?.reason).toBe("a b c");
  });

  test("drops empty and unfilled placeholder reasons", () => {
    expect(
      parseImplementationOutcome(`${summary()}\n${marker('status=blocked reason="<one line>"')}`),
    ).toEqual({ status: "blocked" });
    expect(
      parseImplementationOutcome(`${summary()}\n${marker('status=blocked reason="  "')}`),
    ).toEqual({ status: "blocked" });
  });
});

describe("outcomeRunDisposition", () => {
  test("blocked escalates with the reason", () => {
    expect(outcomeRunDisposition({ status: "blocked", reason: "gate failed" })).toEqual({
      status: "escalated",
      reason: "blocked: gate failed",
    });
    expect(outcomeRunDisposition({ status: "blocked" }).status).toBe("escalated");
  });

  test("partial stays succeeded and keeps the reason", () => {
    expect(outcomeRunDisposition({ status: "partial", reason: "half" })).toEqual({
      status: "succeeded",
      reason: "partial: half",
    });
  });

  test("a pre-existing-on-base partial gets one canonical, auditable prefix", () => {
    for (const reason of [
      "pre-existing on base: lint max-lines in foo.ts",
      "Pre-existing on base:lint max-lines in foo.ts",
      "PRE-EXISTING ON BASE :  lint max-lines in foo.ts",
    ]) {
      const disposition = outcomeRunDisposition({ status: "partial", reason });
      expect(disposition).toEqual({
        status: "succeeded",
        reason: "partial: pre-existing on base: lint max-lines in foo.ts",
      });
      expect(isPreExistingOnBaseReason(disposition.reason)).toBe(true);
      expect(isBlockedOutcomeReason(disposition.reason)).toBe(false);
    }
    expect(outcomeRunDisposition({ status: "partial", reason: "pre-existing on base:" })).toEqual({
      status: "succeeded",
      reason: "partial: pre-existing on base: gate failure",
    });
  });

  test("other partial and blocked reasons are not marked pre-existing on base", () => {
    expect(
      isPreExistingOnBaseReason(
        outcomeRunDisposition({ status: "partial", reason: "half" }).reason,
      ),
    ).toBe(false);
    expect(
      isPreExistingOnBaseReason(
        outcomeRunDisposition({ status: "blocked", reason: "pre-existing on base: lint" }).reason,
      ),
    ).toBe(false);
    expect(isPreExistingOnBaseReason(undefined)).toBe(false);
  });

  test("no marker, done and noop are plain successes", () => {
    expect(outcomeRunDisposition(undefined)).toEqual({ status: "succeeded" });
    expect(outcomeRunDisposition({ status: "done" })).toEqual({ status: "succeeded" });
    expect(outcomeRunDisposition({ status: "noop", reason: "green" })).toEqual({
      status: "succeeded",
    });
  });
});

describe("deliveryRunDisposition", () => {
  const notFound = "GitHub PR creation failed: Not Found";

  test("a run with no PR failure keeps its outcome disposition", () => {
    // --no-git, no --create-pr, or a PR that was created: still a success.
    expect(deliveryRunDisposition({ status: "succeeded" }, undefined)).toEqual({
      status: "succeeded",
    });
    expect(
      deliveryRunDisposition(
        outcomeRunDisposition({ status: "partial", reason: "half" }),
        undefined,
      ),
    ).toEqual({ status: "succeeded", reason: "partial: half" });
  });

  test("pushed but PR creation failed records a failed run with the PR message", () => {
    expect(deliveryRunDisposition(outcomeRunDisposition(undefined), notFound)).toEqual({
      status: "failed",
      reason: `pushed but PR creation failed: ${notFound}`,
    });
    expect(
      deliveryRunDisposition(
        outcomeRunDisposition({ status: "partial", reason: "half" }),
        "GitHub PR creation failed: Bad Gateway",
      ),
    ).toEqual({
      status: "failed",
      reason: "pushed but PR creation failed: GitHub PR creation failed: Bad Gateway",
    });
  });

  test("a blocked run stays escalated and also names the PR failure", () => {
    const disposition = deliveryRunDisposition(
      outcomeRunDisposition({ status: "blocked", reason: "gate failed" }),
      notFound,
    );
    expect(disposition).toEqual({
      status: "escalated",
      reason: `blocked: gate failed; pushed but PR creation failed: ${notFound}`,
    });
  });
});

describe("readImplementationReport outcome", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "impl-outcome-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("parses the marker from the full file, past the persisted excerpt", () => {
    const padding = "progress\n".repeat(5_000);
    writeFileSync(
      join(dir, "implementation-summary.md"),
      `${padding}${summary()}\n${marker('status=blocked reason="gate"')}\n`,
    );
    const report = readImplementationReport(dir, 0);
    expect(report.outcome).toEqual({ status: "blocked", reason: "gate" });
    expect(report.report?.includes("devintern:outcome")).toBe(false);
  });

  test("an incomplete report carries no outcome", () => {
    writeFileSync(
      join(dir, "implementation-summary-incomplete.md"),
      `${summary()}\n${marker("status=blocked")}`,
    );
    expect(readImplementationReport(dir, 0)).toMatchObject({ incomplete: true });
    expect(readImplementationReport(dir, 0).outcome).toBeUndefined();
  });
});

describe("prompt instruction", () => {
  test("the implementation prompt explains the outcome marker and the no-op exception", () => {
    const prompt = withImplementationSummary("Do the task.");
    expect(prompt).toContain('<!-- devintern:outcome status=blocked reason="');
    expect(prompt).toContain("status=partial");
    expect(prompt).toContain("Finding nothing to do is not blocked");
    expect(prompt).toContain("status=noop");
    expect(prompt.indexOf("devintern:summary:end")).toBeLessThan(
      prompt.indexOf("devintern:outcome"),
    );
  });

  test("a gate failure pre-existing on the base is partial unless fixing it is the goal", () => {
    const prompt = withImplementationSummary("Do the task.");
    expect(prompt).toContain("pre-existing on the base commit is not blocked");
    expect(prompt).toContain("re-running\nthe failing gate on the base revision");
    expect(prompt).toContain("enough only for a per-file rule such as a lint max-lines limit");
    expect(prompt).toContain("type errors, import cycles,\nbuild and test failures");
    expect(prompt).toContain("reason that starts with pre-existing on base:");
    expect(prompt).toContain(
      "Use status=blocked if you cannot confirm this, or if the task's goal is to make that gate pass.",
    );
  });

  test("the example marker in the prompt parses as blocked", () => {
    const prompt = withImplementationSummary("Do the task.");
    const example = prompt.split("\n").find((line) => line.startsWith("<!-- devintern:outcome"));
    expect(example && parseImplementationOutcome(`${summary()}\n${example}`)?.status).toBe(
      "blocked",
    );
  });
});

describe("run outcome hint protocol", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-outcome-hint-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips through the env-named file", () => {
    const path = join(dir, "hint.json");
    writeRunOutcomeHint(
      { status: "escalated", reason: "blocked: gate" },
      {
        [RUN_OUTCOME_FILE_ENV]: path,
      },
    );
    expect(readRunOutcomeHint(path)).toEqual({ status: "escalated", reason: "blocked: gate" });
  });

  test("is a no-op without the env var and rejects malformed files", () => {
    writeRunOutcomeHint({ status: "succeeded" }, {});
    expect(readRunOutcomeHint(undefined)).toBeUndefined();
    expect(readRunOutcomeHint(join(dir, "missing.json"))).toBeUndefined();
    const path = join(dir, "bad.json");
    for (const content of ["not json", "null", '{"status":"in_progress"}', '{"status":"great"}']) {
      writeFileSync(path, content);
      expect(readRunOutcomeHint(path)).toBeUndefined();
    }
  });
});
