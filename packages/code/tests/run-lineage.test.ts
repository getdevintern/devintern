import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { readRunLineage } from "../src/lib/state/run-lineage";
import { parseRunOutputs, RUN_ID_ENV, RUN_OUTPUTS_ENV } from "../src/lib/state/run-outputs";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunMeta } from "../src/lib/state/run-recorder";
import { parseWorkerAddArgs, runWorkerAdd } from "../src/lib/workspace/add-command";
import { workspaceDbPath } from "../src/lib/workspace/paths";
import { handleRunDetail, DashboardData } from "../src/lib/observability/dashboard-api";

const PR_URL = "https://github.com/acme/api/pull/260";

describe("injected_tasks parent_run_id migration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lineage-migration-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("adds the column to a legacy table without touching existing rows", () => {
    const path = join(dir, "queue.db");
    const legacy = new Database(path);
    legacy.run(`
      CREATE TABLE injected_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        task_file TEXT NOT NULL,
        idempotency_key TEXT,
        actor TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        message TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      )
    `);
    legacy.run(
      `INSERT INTO injected_tasks (task_key, repo, title, task_file, actor, created_at)
       VALUES ('local-old', 'api', 'Old', '/x.md', 'local:add', 1)`,
    );
    legacy.close();

    const store = new InjectedTaskStore(path);
    try {
      expect(store.getByTaskKey("local-old")?.parentRunId).toBeUndefined();
      const { task } = store.enqueue({
        taskKey: "local-new",
        repo: "api",
        title: "New",
        body: "",
        taskFile: "/y.md",
        parentRunId: 871,
      });
      expect(task.parentRunId).toBe(871);
    } finally {
      store.close();
    }
    // Reopening (a second process) is idempotent.
    new InjectedTaskStore(path).close();
  });

  test("a deduplicated enqueue keeps the original parent", () => {
    const store = new InjectedTaskStore(join(dir, "queue.db"));
    try {
      const base = { repo: "api", title: "T", body: "", taskFile: "/t.md", idempotencyKey: "k" };
      store.enqueue({ ...base, taskKey: "local-t", parentRunId: 1 });
      const again = store.enqueue({ ...base, taskKey: "local-t-2", parentRunId: 2 });
      expect(again.deduplicated).toBe(true);
      expect(again.task.parentRunId).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("worker add lineage", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lineage-add-"));
    configPath = join(dir, "workspace.toml");
    writeFileSync(
      configPath,
      `[workspace]\ndashboard = false\n\n[defaults]\ntracker = "markdown"\n\n[[repos]]\nname = "backend"\nremote = "git@github.com:acme/backend.git"\n`,
    );
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
  });
  afterEach(() => {
    delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
    rmSync(dir, { recursive: true, force: true });
  });

  async function add(args: string[], env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runWorkerAdd(["--workspace", configPath, "--json", ...args], {
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      env,
    });
    return { code, result: JSON.parse(out.at(-1)!), err };
  }

  function readTask(id: number) {
    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      return store.getById(id)!;
    } finally {
      store.close();
    }
  }

  test("parses --parent-run and rejects bad ids or --resume", () => {
    expect(parseWorkerAddArgs(["--title", "x", "--parent-run", "871"])).toMatchObject({
      kind: "ok",
      options: { parentRunId: 871 },
    });
    for (const bad of ["0", "abc", "1.5"]) {
      expect(parseWorkerAddArgs(["--title", "x", "--parent-run", bad]).kind).toBe("error");
    }
    expect(parseWorkerAddArgs(["--resume", "local-x", "--parent-run", "3"]).kind).toBe("error");
  });

  test("records DEVINTERN_RUN_ID as the parent and appends an outputs record", async () => {
    const outputs = join(dir, "state", "run-outputs", "871.jsonl");
    const { code, result } = await add(["--title", "Fix onboarding copy"], {
      [RUN_ID_ENV]: "871",
      [RUN_OUTPUTS_ENV]: outputs,
    });
    expect(code).toBe(0);
    expect(readTask(result.id).parentRunId).toBe(871);
    expect(parseRunOutputs(readFileSync(outputs, "utf8")).records).toEqual([
      {
        kind: "injected_task",
        id: result.id,
        taskKey: result.taskKey,
        title: "Fix onboarding copy",
        repo: "backend",
      },
    ]);
  });

  test("--parent-run wins over the env and does not credit the surrounding run", async () => {
    const outputs = join(dir, "871.jsonl");
    const { result } = await add(["--title", "Explicit", "--parent-run", "12"], {
      [RUN_ID_ENV]: "871",
      [RUN_OUTPUTS_ENV]: outputs,
    });
    expect(readTask(result.id).parentRunId).toBe(12);
    expect(() => readFileSync(outputs, "utf8")).toThrow();
  });

  test("a deduplicated add neither overwrites the parent nor appends a record", async () => {
    const first = await add(["--title", "Dedup", "--idempotency-key", "k"], {
      [RUN_ID_ENV]: "1",
    });
    const outputs = join(dir, "2.jsonl");
    const second = await add(["--title", "Dedup", "--idempotency-key", "k"], {
      [RUN_ID_ENV]: "2",
      [RUN_OUTPUTS_ENV]: outputs,
    });
    expect(second.result.deduplicated).toBe(true);
    expect(readTask(first.result.id).parentRunId).toBe(1);
    expect(() => readFileSync(outputs, "utf8")).toThrow();
  });

  test("without a run id no parent is recorded", async () => {
    const { result } = await add(["--title", "Standalone"], {});
    expect(readTask(result.id).parentRunId).toBeUndefined();
  });
});

describe("run lineage query", () => {
  let dir: string;
  let dbPath: string;
  let runs: RunStore;
  let queue: InjectedTaskStore;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lineage-query-"));
    mkdirSync(join(dir, "state"), { recursive: true });
    dbPath = join(dir, "state", "queue.db");
    runs = new RunStore(dbPath);
    queue = new InjectedTaskStore(dbPath);
    db = new Database(dbPath);
  });
  afterEach(() => {
    db.close();
    queue.close();
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(meta: RunMeta, startedAt: number, pr?: { url: string; number: number }): number {
    const id = runs.createRun(meta);
    db.run("UPDATE runs SET started_at = ? WHERE id = ?", [startedAt, id]);
    if (pr) runs.setRunPr(id, { url: pr.url, prNumber: pr.number });
    return id;
  }

  function lineageOf(id: number) {
    return readRunLineage(dbPath, dbPath, runs.getRun(id)!);
  }

  test("delegated tasks link parent and child, with the child's latest run", () => {
    const parent = run({ origin: "scheduled", automationId: "onboarding-improvements" }, 100);
    const { task } = queue.enqueue({
      taskKey: "local-fix-copy",
      repo: "api",
      title: "Fix copy",
      body: "",
      taskFile: "/t.md",
      parentRunId: parent,
    });
    const child = run({ origin: "local", taskKey: "local-fix-copy" }, 200, {
      url: "https://github.com/acme/api/pull/9",
      number: 9,
    });
    runs.addRunOutputs(parent, [
      { kind: "injected_task", id: task.id, taskKey: task.taskKey },
      { kind: "tracker_issue", tracker: "jira", key: "DEV-210", url: "https://j/DEV-210" },
    ]);

    expect(lineageOf(child).parent).toEqual({
      runId: parent,
      origin: "scheduled",
      status: "in_progress",
      relation: "delegated",
      automationId: "onboarding-improvements",
    });
    expect(lineageOf(parent)).toEqual({
      parent: null,
      spawned: [
        {
          kind: "delegated_task",
          id: task.id,
          taskKey: "local-fix-copy",
          title: "Fix copy",
          status: "pending",
          latestRunId: child,
          latestRunStatus: "in_progress",
          prNumber: 9,
          prUrl: "https://github.com/acme/api/pull/9",
        },
        { kind: "tracker_issue", key: "DEV-210", tracker: "jira", url: "https://j/DEV-210" },
      ],
    });
  });

  test("the outputs record keeps the link after the queue row is pruned", () => {
    const parent = run({ origin: "scheduled" }, 100);
    runs.addRunOutputs(parent, [
      { kind: "injected_task", id: 44, taskKey: "local-gone", title: "Gone" },
    ]);
    const child = run({ origin: "local", taskKey: "local-gone" }, 200);
    expect(lineageOf(child).parent?.runId).toBe(parent);
    expect(lineageOf(parent).spawned).toEqual([
      {
        kind: "delegated_task",
        id: 44,
        taskKey: "local-gone",
        title: "Gone",
        latestRunId: child,
        latestRunStatus: "in_progress",
      },
    ]);
  });

  test("a forged outputs record cannot claim a tracker run or another run's task", () => {
    const owner = run({ origin: "scheduled" }, 50);
    const { task } = queue.enqueue({
      taskKey: "local-real",
      repo: "api",
      title: "Real",
      body: "",
      taskFile: "/t.md",
      parentRunId: owner,
    });
    const forger = run({ origin: "local", taskKey: "local-forger" }, 100);
    runs.addRunOutputs(forger, [
      { kind: "injected_task", id: 1, taskKey: "PROJ-1" },
      { kind: "injected_task", id: task.id, taskKey: "local-real" },
    ]);
    const tracker = run({ origin: "task", taskKey: "PROJ-1" }, 200);
    // A non-ad-hoc run with a local- key (no queue row) is not trusted either.
    runs.addRunOutputs(forger, [{ kind: "injected_task", id: 2, taskKey: "local-manual" }]);
    const manual = run({ origin: "manual", taskKey: "local-manual" }, 300);

    expect(lineageOf(tracker).parent).toBeNull();
    expect(lineageOf(manual).parent).toBeNull();
    // Only the unverifiable (pruned-looking) local- key survives; PROJ-1 and
    // the queue-owned local-real are dropped.
    expect(lineageOf(forger).spawned.map((s) => s.kind === "delegated_task" && s.taskKey)).toEqual([
      "local-manual",
    ]);
    expect(lineageOf(owner).spawned.map((s) => s.kind === "delegated_task" && s.taskKey)).toEqual([
      "local-real",
    ]);
  });

  test("a forged outputs record cannot claim a standalone task", () => {
    // A queue row with no parent (added outside any run) is authoritative:
    // the forger's record must not make it the child's parent.
    queue.enqueue({
      taskKey: "local-standalone",
      repo: "api",
      title: "Standalone",
      body: "",
      taskFile: "/s.md",
    });
    const forger = run({ origin: "scheduled" }, 100);
    runs.addRunOutputs(forger, [{ kind: "injected_task", id: 1, taskKey: "local-standalone" }]);
    const child = run({ origin: "local", taskKey: "local-standalone" }, 200);

    expect(lineageOf(child).parent).toBeNull();
    expect(lineageOf(forger).spawned).toEqual([]);
  });

  test("reaping orphans ingests outputs files that endRun never read", () => {
    const previousWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = dir;
    try {
      const outputsDir = join(dir, "state", "run-outputs");
      mkdirSync(outputsDir, { recursive: true });
      const line = `${JSON.stringify({ v: 1, kind: "tracker_issue", key: "DEV-9", tracker: "jira" })}\n`;
      const crashed = run({ origin: "scheduled" }, 100);
      const settled = run({ origin: "scheduled" }, 150);
      runs.finishRun(settled, "failed", "killed"); // a path that bypasses endRun
      for (const id of [crashed, settled, 9999]) {
        writeFileSync(join(outputsDir, `${id}.jsonl`), line);
      }

      expect(runs.reapOrphanedRuns()).toBe(1);
      for (const id of [crashed, settled]) {
        expect(lineageOf(id).spawned).toEqual([
          { kind: "tracker_issue", key: "DEV-9", tracker: "jira" },
        ]);
      }
      // An id this database does not know is left alone.
      expect(readFileSync(join(outputsDir, "9999.jsonl"), "utf8")).toBe(line);

      // A run still in progress keeps its file until it settles.
      const live = run({ origin: "scheduled" }, 300);
      writeFileSync(join(outputsDir, `${live}.jsonl`), line);
      expect(runs.ingestSettledRunOutputs()).toBe(0);
      expect(readFileSync(join(outputsDir, `${live}.jsonl`), "utf8")).toBe(line);
      runs.finishRun(live, "succeeded");
      expect(runs.ingestSettledRunOutputs()).toBe(1);
      expect(lineageOf(live).spawned).toHaveLength(1);
    } finally {
      if (previousWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
      else process.env.DEVINTERN_WORKSPACE_DIR = previousWorkspace;
    }
  });

  test("follow-up runs on a PR point at the run that opened it", () => {
    const pr = { url: PR_URL, number: 260 };
    const opener = run({ origin: "task", taskKey: "PROJ-1" }, 100, pr);
    const retry = run({ origin: "task", taskKey: "PROJ-1" }, 150, pr);
    const ciFix = run({ origin: "ci_fix", prUrl: PR_URL, prNumber: 260 }, 200);
    const merge = run({ origin: "auto_merge", prUrl: PR_URL, prNumber: 260 }, 300);
    run({ origin: "ci_fix", prUrl: "https://github.com/acme/api/pull/999" }, 250);

    for (const id of [ciFix, merge]) {
      expect(lineageOf(id).parent).toEqual({
        runId: opener,
        origin: "task",
        status: "in_progress",
        relation: "follow_up",
        taskKey: "PROJ-1",
        prNumber: 260,
        prUrl: PR_URL,
      });
    }
    expect(lineageOf(opener).spawned.map((s) => s.kind === "follow_up_run" && s.runId)).toEqual([
      ciFix,
      merge,
    ]);
    // A later attempt on the same PR is not the opener: no follow-ups, no parent.
    expect(lineageOf(retry)).toEqual({ parent: null, spawned: [] });
  });

  test("a run with no lineage, or a missing DB, reads as empty", () => {
    const lone = run({ origin: "task", taskKey: "PROJ-2" }, 100);
    expect(lineageOf(lone)).toEqual({ parent: null, spawned: [] });
    expect(readRunLineage(join(dir, "missing.db"), dbPath, runs.getRun(lone)!)).toEqual({
      parent: null,
      spawned: [],
    });
  });

  test("the run detail endpoint returns lineage", () => {
    const parent = run({ origin: "scheduled", automationId: "a" }, 100);
    queue.enqueue({
      taskKey: "local-c",
      repo: "api",
      title: "C",
      body: "",
      taskFile: "/c.md",
      parentRunId: parent,
    });
    const child = run({ origin: "local", taskKey: "local-c" }, 200);
    const data = new DashboardData({ dbPath, queueDbPath: dbPath, workspaceDir: dir, logDirs: [] });
    try {
      const response = handleRunDetail(data, String(child));
      expect(response.status).toBe(200);
      const body = response.body as { lineage: { parent: { runId: number; relation: string } } };
      expect(body.lineage.parent).toMatchObject({ runId: parent, relation: "delegated" });
    } finally {
      data.close();
    }
  });
});
