import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  appendRunOutput,
  ingestRunOutputsFile,
  parseRunId,
  parseRunOutputLine,
  parseRunOutputs,
  RUN_ID_ENV,
  RUN_OUTPUTS_ENV,
  serializeRunOutput,
} from "../src/lib/state/run-outputs";
import { beginRun, endRun, RunStore } from "../src/lib/state/run-recorder";
import { runOutputsPath } from "../src/lib/workspace/paths";

describe("run outputs record parser", () => {
  test("parses a tracker_issue record and keeps only http(s) URLs", () => {
    expect(
      parseRunOutputLine(
        '{"v":1,"kind":"tracker_issue","tracker":"jira","key":"DEV-210","url":"https://acme.atlassian.net/browse/DEV-210","title":"Onboarding copy"}',
      ),
    ).toEqual({
      ok: true,
      record: {
        kind: "tracker_issue",
        tracker: "jira",
        key: "DEV-210",
        url: "https://acme.atlassian.net/browse/DEV-210",
        title: "Onboarding copy",
      },
    });
    expect(
      parseRunOutputLine('{"v":1,"kind":"tracker_issue","key":"X-1","url":"javascript:alert(1)"}'),
    ).toEqual({ ok: true, record: { kind: "tracker_issue", key: "X-1" } });
  });

  test("parses an injected_task record", () => {
    expect(
      parseRunOutputLine('{"v":1,"kind":"injected_task","id":132,"taskKey":"local-fix"}'),
    ).toEqual({ ok: true, record: { kind: "injected_task", id: 132, taskKey: "local-fix" } });
  });

  test("rejects malformed, unversioned, unknown-kind, and incomplete lines", () => {
    for (const line of [
      "not json",
      "[1,2]",
      '{"kind":"tracker_issue","key":"A-1"}',
      '{"v":2,"kind":"tracker_issue","key":"A-1"}',
      '{"v":1,"kind":"comment"}',
      '{"v":1,"kind":"tracker_issue","key":"  "}',
      '{"v":1,"kind":"injected_task","id":"132","taskKey":"k"}',
      '{"v":1,"kind":"injected_task","id":-1,"taskKey":"k"}',
      '{"v":1,"kind":"injected_task","id":5}',
    ]) {
      expect(parseRunOutputLine(line).ok).toBe(false);
    }
  });

  test("parses a file, skipping blank and bad lines with line numbers", () => {
    const parsed = parseRunOutputs(
      [
        '{"v":1,"kind":"tracker_issue","key":"A-1"}',
        "",
        "{oops",
        '{"v":1,"kind":"injected_task","id":1,"taskKey":"local-a"}',
      ].join("\n"),
    );
    expect(parsed.records).toHaveLength(2);
    expect(parsed.skipped).toEqual([{ line: 3, error: "not valid JSON" }]);
  });

  test("serialize round-trips through the parser", () => {
    const record = { kind: "injected_task" as const, id: 7, taskKey: "local-x", title: "X" };
    expect(parseRunOutputLine(serializeRunOutput(record))).toEqual({ ok: true, record });
  });

  test("parseRunId accepts only positive integers", () => {
    expect(parseRunId("871")).toBe(871);
    expect(parseRunId(" 12 ")).toBe(12);
    for (const raw of [undefined, "", "0", "-3", "1.5", "abc"]) {
      expect(parseRunId(raw)).toBeUndefined();
    }
  });
});

describe("run outputs storage and ingestion", () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-outputs-"));
    store = new RunStore(join(dir, "queue.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ingests valid records, logs skipped lines, dedupes, and removes the file", () => {
    const runId = store.createRun({ origin: "scheduled", automationId: "onboarding" });
    const path = join(dir, "run-outputs", `${runId}.jsonl`);
    appendRunOutput(path, { kind: "tracker_issue", tracker: "jira", key: "DEV-210" });
    appendRunOutput(path, { kind: "tracker_issue", tracker: "jira", key: "DEV-210" });
    writeFileSync(path, `${readFileSync(path, "utf8")}garbage\n`);
    appendRunOutput(path, { kind: "injected_task", id: 3, taskKey: "local-a" });

    const logs: string[] = [];
    expect(ingestRunOutputsFile(store, runId, path, (m) => logs.push(m))).toBe(2);
    expect(logs).toEqual([`⚠️  Run ${runId} outputs line 3 skipped: not valid JSON`]);
    expect(existsSync(path)).toBe(false);
    expect(store.listRunOutputs(runId).map((o) => [o.kind, o.refKey])).toEqual([
      ["tracker_issue", "DEV-210"],
      ["injected_task", "local-a"],
    ]);
  });

  test("a missing file is a no-op", () => {
    expect(ingestRunOutputsFile(store, 1, join(dir, "nope.jsonl"), () => {})).toBe(0);
  });

  test("storage failures are logged, never thrown", () => {
    const path = join(dir, "x.jsonl");
    writeFileSync(path, '{"v":1,"kind":"tracker_issue","key":"A-1"}\n');
    const logs: string[] = [];
    const broken = {
      addRunOutputs: () => {
        throw new Error("disk full");
      },
    };
    expect(ingestRunOutputsFile(broken, 9, path, (m) => logs.push(m))).toBe(0);
    expect(logs[0]).toContain("disk full");
  });
});

describe("ambient run identity", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-identity-"));
    delete process.env[RUN_ID_ENV];
    delete process.env[RUN_OUTPUTS_ENV];
  });

  afterEach(() => {
    for (const key of [RUN_ID_ENV, RUN_OUTPUTS_ENV]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("beginRun exports the run id and outputs path; endRun ingests and clears them", () => {
    beginRun({ origin: "scheduled", automationId: "onboarding-improvements" });
    const runId = parseRunId(process.env[RUN_ID_ENV]);
    expect(runId).toBeDefined();
    const outputs = process.env[RUN_OUTPUTS_ENV]!;
    expect(outputs).toBe(runOutputsPath(runId!));
    // The directory exists so tools can append with plain redirection.
    writeFileSync(outputs, '{"v":1,"kind":"tracker_issue","key":"DEV-1"}\nbroken\n');

    endRun("succeeded");
    expect(process.env[RUN_ID_ENV]).toBeUndefined();
    expect(process.env[RUN_OUTPUTS_ENV]).toBeUndefined();

    // The ambient recorder writes to the default (test-pinned) queue DB.
    const store = new RunStore();
    try {
      expect(store.getRun(runId!)?.status).toBe("succeeded");
      expect(store.listRunOutputs(runId!).map((o) => o.refKey)).toEqual(["DEV-1"]);
    } finally {
      store.close();
    }
  });

  test("endRun restores an identity inherited from a parent run", () => {
    process.env[RUN_ID_ENV] = "5";
    process.env[RUN_OUTPUTS_ENV] = "/parent/5.jsonl";
    beginRun({ origin: "manual", taskKey: "PROJ-1" });
    expect(process.env[RUN_ID_ENV]).not.toBe("5");
    endRun("failed", "x");
    expect(process.env[RUN_ID_ENV]).toBe("5");
    expect(process.env[RUN_OUTPUTS_ENV]).toBe("/parent/5.jsonl");
  });
});
