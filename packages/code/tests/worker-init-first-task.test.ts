/**
 * The wizard's sample first task (`init/worker-init-first-task.ts`): how a
 * sample matches the saved query, creation per tracker with mocked clients,
 * the `worker add` fallback, the bounded wait for the run, and declining.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  SAMPLE_MARKDOWN_STEM,
  SAMPLE_TASK_BODY,
  SAMPLE_TASK_TITLE,
  defaultEnqueueSampleAdHoc,
  defaultFindSampleRun,
  defaultSampleTicketOps,
  offerFirstTask,
  sampleTaskAddCommand,
  sampleTaskMatch,
  waitForSampleRun,
} from "../src/lib/init/worker-init-first-task";
import type {
  CreatedSampleTask,
  FirstTaskContext,
  FirstTaskDeps,
  SampleTaskMatch,
  SampleTicketOps,
} from "../src/lib/init/worker-init-first-task";
import { RunStore } from "../src/lib/state/run-recorder";
import { MarkdownTaskTrackerClient } from "../src/lib/trackers/markdown/markdown-task-tracker-client";
import { workspaceDbPath } from "../src/lib/workspace/paths";

const originalFetch = globalThis.fetch;

type CapturedRequest = { url: string; method: string; body?: unknown };

function mockFetch(json: unknown): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(json), { status: 201 });
  }) as typeof fetch;
  return calls;
}

let tempDir: string;
let workspaceDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "devintern-first-task-"));
  workspaceDir = join(tempDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "workspace.toml"),
    '[workspace]\ndashboard = true\n\n[defaults]\ntracker = "github"\ntask_query = "is:open label:devintern"\npoll_interval = 45\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("sampleTaskMatch", () => {
  test("github: applies the query's labels; open-state terms need nothing", () => {
    expect(sampleTaskMatch("github", "is:open label:devintern")).toEqual({
      labels: ["devintern"],
      fields: {},
      unmatched: [],
    });
    expect(sampleTaskMatch("github", 'is:open label:"good first",ai -label:wontfix')).toEqual({
      labels: ["good first", "ai"],
      fields: {},
      unmatched: [],
    });
  });

  test("github: reports terms a new issue cannot satisfy", () => {
    expect(sampleTaskMatch("github", "is:open label:ai assignee:me milestone:v2")).toEqual({
      labels: ["ai"],
      fields: {},
      unmatched: ["assignee:me", "milestone:v2"],
    });
  });

  test("github: terms a fresh issue already satisfies are not flagged", () => {
    expect(
      sampleTaskMatch(
        "github",
        "is:open label:devintern no:assignee no:milestone sort:created-asc is:unassigned repo:Acme/App",
        "acme/app",
      ),
    ).toEqual({ labels: ["devintern"], fields: {}, unmatched: [] });
    // Another repository's issues are not where the sample goes.
    expect(sampleTaskMatch("github", "label:ai repo:acme/other", "acme/app").unmatched).toEqual([
      "repo:acme/other",
    ]);
  });

  test("gitlab: drops the None/Any keywords", () => {
    expect(sampleTaskMatch("gitlab", "state:opened label:devintern label:Any").labels).toEqual([
      "devintern",
    ]);
  });

  test("markdown: frontmatter filters, free text unmatched", () => {
    expect(sampleTaskMatch("markdown", 'status=todo type="Docs task"')).toEqual({
      labels: [],
      fields: { status: "todo", type: "Docs task" },
      unmatched: [],
    });
    expect(sampleTaskMatch("markdown", "status=todo login").unmatched).toEqual(["login"]);
  });
});

describe("defaultSampleTicketOps", () => {
  test("undefined for trackers without sample creation or with missing credentials", () => {
    for (const tracker of ["jira", "linear", "azure-devops", "trello", "asana"]) {
      expect(defaultSampleTicketOps(tracker, { GITHUB_TOKEN: "t" })).toBeUndefined();
    }
    expect(defaultSampleTicketOps("github", { GITHUB_TOKEN: "t" })).toBeUndefined();
    expect(defaultSampleTicketOps("gitlab", { GITLAB_TOKEN: "t" })).toBeUndefined();
    expect(defaultSampleTicketOps("markdown", {})).toBeUndefined();
  });

  test("github: posts a labeled sample issue", async () => {
    const calls = mockFetch({ number: 42, html_url: "https://github.com/acme/app/issues/42" });
    const ops = defaultSampleTicketOps("github", {
      GITHUB_TOKEN: "ghp_x",
      GITHUB_REPO: "acme/app",
    })!;
    expect(ops.location).toBe("acme/app");
    const created = await ops.create({ labels: ["devintern"], fields: {}, unmatched: [] });
    expect(created).toEqual({ key: "42", url: "https://github.com/acme/app/issues/42" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/app/issues",
      body: { title: SAMPLE_TASK_TITLE, body: SAMPLE_TASK_BODY, labels: ["devintern"] },
    });
  });

  test("gitlab: posts a labeled sample issue keyed by iid", async () => {
    const calls = mockFetch({ id: 900, iid: 7, project_id: 1, title: "", web_url: "https://gl/7" });
    const ops = defaultSampleTicketOps("gitlab", {
      GITLAB_TOKEN: "glpat-x",
      GITLAB_PROJECT: "acme/app",
    })!;
    const created = await ops.create({ labels: ["devintern", "ai"], fields: {}, unmatched: [] });
    expect(created).toEqual({ key: "7", url: "https://gl/7" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/projects/acme%2Fapp/issues");
    expect(calls[0]!.body).toMatchObject({ title: SAMPLE_TASK_TITLE, labels: "devintern,ai" });
  });

  test("markdown: writes a task file the saved query finds, never overwriting", async () => {
    const tasksDir = join(tempDir, "tasks");
    const ops = defaultSampleTicketOps("markdown", { MARKDOWN_TASKS_DIR: tasksDir })!;
    const match = sampleTaskMatch("markdown", "status=todo");
    const first = await ops.create(match);
    const second = await ops.create(match);
    expect(first.key).toBe(SAMPLE_MARKDOWN_STEM);
    expect(second.key).toBe(`${SAMPLE_MARKDOWN_STEM}-2`);
    expect(readdirSync(tasksDir).sort()).toEqual([
      `${SAMPLE_MARKDOWN_STEM}-2.md`,
      `${SAMPLE_MARKDOWN_STEM}.md`,
    ]);
    const found = await new MarkdownTaskTrackerClient({ tasksDirectory: tasksDir }).searchTasks(
      "status=todo",
    );
    expect(found.tasks.map((task) => task.key).sort()).toEqual([first.key, second.key].sort());
    expect(found.tasks[0]!.summary).toBe(SAMPLE_TASK_TITLE);
  });
});

describe("sampleTaskAddCommand", () => {
  test("one runnable line with the workspace prefix when not the default home", () => {
    const command = sampleTaskAddCommand(workspaceDir, "app", tempDir);
    expect(command).toStartWith(`DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker add`);
    expect(command).toContain("--repo app --title 'DevIntern sample task:");
    expect(command).not.toContain("\n");
    expect(sampleTaskAddCommand(join(tempDir, ".devintern"), undefined, tempDir)).toStartWith(
      "devintern worker add --title",
    );
  });
});

describe("defaultFindSampleRun", () => {
  test("finds the task's run started after the offer, not older ones", () => {
    expect(defaultFindSampleRun(workspaceDir, "42", 0)).toBeNull();
    const dbPath = workspaceDbPath(workspaceDir);
    mkdirSync(join(workspaceDir, "state"), { recursive: true });
    const store = new RunStore(dbPath);
    const id = store.createRun({ origin: "task", taskKey: "42" });
    store.close();
    expect(defaultFindSampleRun(workspaceDir, "42", 0)).toEqual({ id, status: "in_progress" });
    expect(defaultFindSampleRun(workspaceDir, "43", 0)).toBeNull();
    expect(defaultFindSampleRun(workspaceDir, "42", Date.now() + 60_000)).toBeNull();
  });
});

/** Fake clock: `sleep` advances `now`, so waits finish instantly. */
function fakeClock(): Pick<FirstTaskDeps, "now" | "sleep"> & { slept: number[] } {
  let time = 1_000_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
  };
}

function context(
  answers: string[],
  deps: FirstTaskDeps,
  overrides: Partial<FirstTaskContext> = {},
): { ctx: FirstTaskContext; logs: string[]; questions: string[] } {
  const logs: string[] = [];
  const questions: string[] = [];
  const queued = [...answers];
  return {
    logs,
    questions,
    ctx: {
      trackerType: "github",
      trackerName: "GitHub",
      workspaceDir,
      repoName: "app",
      log: (message) => logs.push(message),
      prompt: async (question) => {
        questions.push(question);
        return queued.shift() ?? "";
      },
      env: {},
      deps,
      ...overrides,
    },
  };
}

function recordingOps(created: CreatedSampleTask = { key: "42", url: "https://gh/42" }) {
  const calls: SampleTaskMatch[] = [];
  const ops: SampleTicketOps = {
    location: "acme/app",
    noun: "issue",
    create: async (match) => {
      calls.push(match);
      return created;
    },
  };
  return { ops, calls };
}

describe("offerFirstTask", () => {
  test("declining creates nothing and does not wait", async () => {
    const { ops, calls } = recordingOps();
    let polled = 0;
    const { ctx, logs, questions } = context(["n"], {
      sampleTicketOps: () => ops,
      findRun: () => {
        polled++;
        return null;
      },
    });
    expect(await offerFirstTask(ctx)).toBeUndefined();
    expect(questions[0]).toContain("Create a sample ticket in acme/app");
    expect(questions[0]).toContain("[Y/n]");
    expect(calls).toEqual([]);
    expect(polled).toBe(0);
    expect(logs.join("\n")).toContain("No sample created.");
  });

  test("declining the worker add fallback queues nothing", async () => {
    let enqueued = 0;
    const { ctx } = context(["n"], {
      sampleTicketOps: () => undefined,
      enqueueAdHoc: async () => {
        enqueued++;
        return { key: "local-1" };
      },
    });
    expect(await offerFirstTask(ctx)).toBeUndefined();
    expect(enqueued).toBe(0);
  });

  test("Enter creates the labeled sample and links the run once it starts", async () => {
    const { ops, calls } = recordingOps();
    const clock = fakeClock();
    let polls = 0;
    const { ctx, logs } = context([""], {
      ...clock,
      sampleTicketOps: () => ops,
      findRun: (dir, key) => {
        expect(dir).toBe(workspaceDir);
        expect(key).toBe("42");
        return ++polls >= 3 ? { id: 17, status: "in_progress" } : null;
      },
    });
    expect(await offerFirstTask(ctx)).toEqual({ key: "42", url: "https://gh/42" });
    expect(calls).toEqual([{ labels: ["devintern"], fields: {}, unmatched: [] }]);
    const all = logs.join("\n");
    expect(all).toContain(
      "Created the sample issue 42 in GitHub, labeled devintern: https://gh/42",
    );
    expect(all).toContain("The worker started 42 (run #17).");
    expect(all).toContain("http://localhost:4400/#/runs/17");
    expect(polls).toBe(3);
  });

  test("a query setup cannot satisfy: says how to make the ticket match, no wait", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "github"\ntask_query = "is:open label:ai assignee:me"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
    );
    const { ops } = recordingOps();
    let polled = 0;
    const { ctx, logs } = context(["y"], {
      sampleTicketOps: () => ops,
      findRun: () => {
        polled++;
        return null;
      },
    });
    await offerFirstTask(ctx);
    expect(polled).toBe(0);
    expect(logs.join("\n")).toContain(
      "Your query also selects on assignee:me, which setup cannot set. Make 42 match it",
    );
  });

  test("a failed creation warns and prints the worker add command", async () => {
    const { ctx, logs } = context(["y"], {
      sampleTicketOps: () => ({
        location: "acme/app",
        noun: "issue",
        create: async () => {
          throw new Error("403 Resource not accessible");
        },
      }),
      findRun: () => {
        throw new Error("must not poll");
      },
    });
    expect(await offerFirstTask(ctx)).toBeUndefined();
    const all = logs.join("\n");
    expect(all).toContain("Could not create the sample issue: 403 Resource not accessible");
    expect(all).toContain("devintern worker add --repo app --title");
  });

  test("markdown asks to write a task file", async () => {
    const tasksDir = join(tempDir, "tasks");
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "markdown"\ntask_query = "status=todo"\n',
    );
    const clock = fakeClock();
    const { ctx, questions, logs } = context(
      [""],
      {
        ...clock,
        sampleTicketOps: defaultSampleTicketOps,
        findRun: () => ({ id: 3, status: "in_progress" }),
      },
      { trackerType: "markdown", trackerName: "markdown", env: { MARKDOWN_TASKS_DIR: tasksDir } },
    );
    const created = await offerFirstTask(ctx);
    expect(questions[0]).toContain(`Write a sample task file to ${tasksDir}`);
    expect(created?.key).toBe(SAMPLE_MARKDOWN_STEM);
    expect(existsSync(join(tasksDir, `${SAMPLE_MARKDOWN_STEM}.md`))).toBe(true);
    expect(logs.join("\n")).toContain("The worker started devintern-sample-first-task");
  });

  test("no ticket creation: queues the sample with worker add, then waits", async () => {
    const clock = fakeClock();
    const enqueued: Array<{ workspaceDir: string; repo?: string }> = [];
    const { ctx, questions, logs } = context(
      ["y"],
      {
        ...clock,
        sampleTicketOps: () => undefined,
        enqueueAdHoc: async (input) => {
          enqueued.push(input);
          return { key: "local-sample" };
        },
        findRun: (_dir, key) => (key === "local-sample" ? { id: 5, status: "in_progress" } : null),
      },
      { trackerType: "jira", trackerName: "JIRA" },
    );
    expect(await offerFirstTask(ctx)).toEqual({ key: "local-sample" });
    expect(questions[0]).toContain("Queue a sample task with `devintern worker add`");
    expect(enqueued).toEqual([{ workspaceDir, repo: "app" }]);
    expect(logs.join("\n")).toContain("Queued the sample task local-sample.");
    expect(logs.join("\n")).toContain("#/runs/5");
  });

  test("github: a registered repo other than GITHUB_REPO gets the sample through worker add", async () => {
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "github"\ntask_query = "label:devintern"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/web.git"\n',
    );
    const { ops, calls } = recordingOps();
    const enqueued: Array<{ workspaceDir: string; repo?: string }> = [];
    const { ctx, questions, logs } = context(["y"], {
      ...fakeClock(),
      sampleTicketOps: () => ops,
      enqueueAdHoc: async (input) => {
        enqueued.push(input);
        return { key: "local-sample" };
      },
      findRun: () => ({ id: 3, status: "in_progress" }),
    });
    expect(await offerFirstTask(ctx)).toEqual({ key: "local-sample" });
    expect(calls).toEqual([]);
    expect(enqueued).toEqual([{ workspaceDir, repo: "app" }]);
    expect(questions[0]).toContain("Queue a sample task with `devintern worker add`");
    expect(logs.join("\n")).toContain("app is not acme/app");
  });

  test("a failed worker add prints the command to run by hand", async () => {
    const { ctx, logs } = context(["y"], {
      enqueueAdHoc: async () => ({ error: "no repo named app" }),
    });
    expect(await offerFirstTask(ctx)).toBeUndefined();
    expect(logs.join("\n")).toContain("Could not queue the sample task: no repo named app");
    expect(logs.join("\n")).toContain("Try it yourself: ");
  });
});

describe("defaultEnqueueSampleAdHoc", () => {
  // `worker add` runs the real license check; keep it off the network and
  // independent of the host's license state, like the worker-add tests.
  beforeEach(() => {
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
  });
  afterEach(() => {
    delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
  });

  test("queues the sample in the workspace and returns its task key", async () => {
    const result = await defaultEnqueueSampleAdHoc({ workspaceDir, repo: "app" });
    if ("error" in result) throw new Error(result.error);
    expect(result.key).toBeString();
    expect(result.key.length).toBeGreaterThan(0);
    // Queued in this workspace's DB, which the worker reads.
    expect(existsSync(workspaceDbPath(workspaceDir))).toBe(true);
  });

  test("an unknown repo is an error, not a task", async () => {
    const result = await defaultEnqueueSampleAdHoc({ workspaceDir, repo: "nope" });
    expect("error" in result && result.error).toBeTruthy();
  });
});

describe("waitForSampleRun", () => {
  test("stops at the bound and says where the run will show up", async () => {
    const clock = fakeClock();
    let polls = 0;
    const { ctx, logs } = context([], {
      ...clock,
      waitMs: 10_000,
      pollMs: 3_000,
      findRun: () => {
        polls++;
        return null;
      },
    });
    expect(await waitForSampleRun(ctx, { key: "42" }, 0)).toBeNull();
    // 0s, 3s, 6s, 9s, then the last 1s up to the bound.
    expect(clock.slept).toEqual([3_000, 3_000, 3_000, 1_000]);
    expect(polls).toBe(5);
    const all = logs.join("\n");
    expect(all).toContain("Waiting up to 1 minute for the worker to start 42");
    expect(all).toContain("has not started 42 yet (it checks for tasks every 45s).");
    expect(all).toContain("http://localhost:4400/#/runs");
  });
});
