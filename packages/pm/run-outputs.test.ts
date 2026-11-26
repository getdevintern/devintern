import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModuleDir } from "./lib/runtime/path.js";
import { pathExists } from "./lib/runtime/fs.js";
import { createEngine } from "./lib/engine";
import type { Config } from "./lib/config";
import type { CreatedTask, TaskBackend } from "./lib/backends";
import {
  formatTrackerIssueLine,
  recordCreatedTicket,
  RUN_ID_ENV,
  RUN_OUTPUTS_ENV,
} from "./lib/run-outputs.js";

const PROMPTS_DIR = join(getModuleDir(import.meta.url), "prompts");

let dir: string;
let outputs: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "devpm-run-outputs-"));
  outputs = join(dir, "state", "run-outputs", "42.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readRecords(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function configFor(type: string): Config {
  return {
    backend: { type },
    verbose: false,
    agent: {
      harness: { name: "stub", displayName: "Stub", defaultPath: "stub", buildArgs: () => [] },
      path: "stub",
    },
  } as unknown as Config;
}

function backendReturning(task: CreatedTask, subtask?: CreatedTask): TaskBackend {
  return {
    name: "Stub",
    supportsIssueTypes: true,
    supportsEpicLinking: false,
    supportsLabels: false,
    supportsFreeformLabels: false,
    supportsAttachments: false,
    createTask: async () => task,
    createSubtask: async () => subtask ?? task,
  };
}

/** Result shapes each backend's createTask returns. */
const TRACKER_RESULTS: Array<{ tracker: string; task: CreatedTask; url?: string }> = [
  {
    tracker: "jira",
    task: { key: "DEV-210", url: "https://acme.atlassian.net/browse/DEV-210" },
    url: "https://acme.atlassian.net/browse/DEV-210",
  },
  {
    tracker: "linear",
    task: { key: "ENG-7", url: "https://linear.app/acme/issue/ENG-7/title" },
    url: "https://linear.app/acme/issue/ENG-7/title",
  },
  {
    tracker: "trello",
    task: { key: "aB3dE5fG", url: "https://trello.com/c/aB3dE5fG" },
    url: "https://trello.com/c/aB3dE5fG",
  },
  {
    tracker: "azure-devops",
    task: { key: "1234", url: "https://dev.azure.com/acme/Proj/_workitems/edit/1234" },
    url: "https://dev.azure.com/acme/Proj/_workitems/edit/1234",
  },
  {
    tracker: "asana",
    task: { key: "1209876543210", url: "https://app.asana.com/0/1/1209876543210" },
    url: "https://app.asana.com/0/1/1209876543210",
  },
  {
    tracker: "github",
    task: { key: "#88", url: "https://github.com/acme/app/issues/88" },
    url: "https://github.com/acme/app/issues/88",
  },
  {
    tracker: "gitlab",
    task: { key: "#12", url: "https://gitlab.com/acme/app/-/issues/12" },
    url: "https://gitlab.com/acme/app/-/issues/12",
  },
  // Markdown returns a local file path: not a link, so no url field.
  { tracker: "markdown", task: { key: "TASK-3", url: "/repo/.devintern-pm/tasks/TASK-3-x.md" } },
];

describe("engine records created tickets in DEVINTERN_RUN_OUTPUTS", () => {
  for (const { tracker, task, url } of TRACKER_RESULTS) {
    test(`${tracker}: createTask appends one tracker_issue record`, async () => {
      const engine = await createEngine(
        configFor(tracker),
        { promptsDir: PROMPTS_DIR },
        {
          backend: backendReturning(task),
          runOutputs: { env: { [RUN_OUTPUTS_ENV]: outputs, [RUN_ID_ENV]: "42" } },
        },
      );

      const result = await engine.createTask(
        { summary: "Explain workspace setup", description: "D" },
        { issueType: "Task" },
      );

      expect(result.task).toEqual(task);
      expect(await readRecords(outputs)).toEqual([
        {
          v: 1,
          kind: "tracker_issue",
          tracker,
          key: task.key,
          ...(url ? { url } : {}),
          title: "Explain workspace setup",
          parentRunId: 42,
        },
      ]);
    });
  }

  test("createSubtask appends a record per subtask, one line per write", async () => {
    const engine = await createEngine(
      configFor("jira"),
      { promptsDir: PROMPTS_DIR },
      {
        backend: backendReturning(
          { key: "DEV-1", url: "https://acme.atlassian.net/browse/DEV-1" },
          { key: "DEV-2", url: "https://acme.atlassian.net/browse/DEV-2" },
        ),
        runOutputs: { env: { [RUN_OUTPUTS_ENV]: outputs } },
      },
    );

    await engine.createTask({ summary: "Story", description: "D" }, { issueType: "Story" });
    await engine.createSubtask("DEV-1", { summary: "Sub", description: "" });

    const text = await readFile(outputs, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    expect(await readRecords(outputs)).toEqual([
      {
        v: 1,
        kind: "tracker_issue",
        tracker: "jira",
        key: "DEV-1",
        url: "https://acme.atlassian.net/browse/DEV-1",
        title: "Story",
      },
      {
        v: 1,
        kind: "tracker_issue",
        tracker: "jira",
        key: "DEV-2",
        url: "https://acme.atlassian.net/browse/DEV-2",
        title: "Sub",
      },
    ]);
  });

  test("env unset: nothing is written", async () => {
    const engine = await createEngine(
      configFor("jira"),
      { promptsDir: PROMPTS_DIR },
      {
        backend: backendReturning({ key: "DEV-1", url: "https://x/DEV-1" }),
        runOutputs: { env: { [RUN_ID_ENV]: "42" } },
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task" },
    );
    await engine.createSubtask("DEV-1", { summary: "Sub", description: "" });

    expect(result.task.key).toBe("DEV-1");
    expect(await pathExists(outputs)).toBe(false);
  });

  test("unwritable path: warns and creation still succeeds", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const warnings: string[] = [];
    const engine = await createEngine(
      configFor("linear"),
      { promptsDir: PROMPTS_DIR },
      {
        backend: backendReturning({ key: "ENG-1", url: "https://linear.app/a/issue/ENG-1" }),
        runOutputs: {
          env: { [RUN_OUTPUTS_ENV]: join(blocker, "out.jsonl") },
          warn: (message) => warnings.push(message),
        },
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task" },
    );
    const sub = await engine.createSubtask("ENG-1", { summary: "Sub", description: "" });

    expect(result.task.key).toBe("ENG-1");
    expect(sub.key).toBe("ENG-1");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("could not record ENG-1");
    expect(warnings[0]).toContain(RUN_OUTPUTS_ENV);
  });
});

describe("recordCreatedTicket", () => {
  test("defaults to process.env and warns on stderr", async () => {
    const blocker = join(dir, "file");
    await writeFile(blocker, "");
    const original = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.env[RUN_OUTPUTS_ENV] = join(blocker, "out.jsonl");
    try {
      await recordCreatedTicket({ tracker: "jira", key: "DEV-9" });
    } finally {
      delete process.env[RUN_OUTPUTS_ENV];
      process.stderr.write = original;
    }
    expect(written.join("")).toContain("could not record DEV-9");
  });

  test("omits blank titles and a missing run id", () => {
    expect(
      JSON.parse(formatTrackerIssueLine({ tracker: "jira", key: "A-1", title: "  " }, undefined)),
    ).toEqual({ v: 1, kind: "tracker_issue", tracker: "jira", key: "A-1" });
  });

  test("drops a non-numeric DEVINTERN_RUN_ID", async () => {
    await recordCreatedTicket(
      { tracker: "github", key: "#1", url: "https://github.com/a/b/issues/1" },
      { env: { [RUN_OUTPUTS_ENV]: outputs, [RUN_ID_ENV]: "abc" } },
    );
    expect(await readRecords(outputs)).toEqual([
      {
        v: 1,
        kind: "tracker_issue",
        tracker: "github",
        key: "#1",
        url: "https://github.com/a/b/issues/1",
      },
    ]);
  });
});
