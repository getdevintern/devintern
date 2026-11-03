import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { InjectedTaskStore, addAutoResumeColumn } from "../src/lib/state/injected-tasks";

describe("InjectedTaskStore", () => {
  let dir: string;
  let dbPath: string;
  let store: InjectedTaskStore;

  beforeEach(() => {
    dir = join(tmpdir(), `injected-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, "queue.db");
    store = new InjectedTaskStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = {
    taskKey: "local-fix-flaky-test",
    repo: "backend",
    title: "Fix flaky test",
    body: "Investigate the flake.",
    taskFile: "/ws/injected/local-fix-flaky-test.md",
  };

  test("enqueues a pending task and claims it", () => {
    const { task, deduplicated } = store.enqueue(base);
    expect(deduplicated).toBe(false);
    expect(task.status).toBe("pending");
    expect(task.repo).toBe("backend");
    expect(task.actor).toBe("local:add");
    expect(store.hasPending()).toBe(true);

    const claimed = store.claimNext();
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("running");
    expect(store.claimNext()).toBeNull();
  });

  test("enqueue is idempotent on the idempotency key", () => {
    const first = store.enqueue({ ...base, idempotencyKey: "run-42" });
    const second = store.enqueue({
      ...base,
      taskKey: "local-other",
      taskFile: "/ws/injected/other.md",
      idempotencyKey: "run-42",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(store.list()).toHaveLength(1);
  });

  test("reuses a settled idempotency key for a new occurrence", () => {
    const first = store.enqueue({ ...base, idempotencyKey: "nightly-docs" });
    const claimed = store.claimNext()!;
    expect(store.findActiveByIdempotencyKey("nightly-docs")?.id).toBe(first.task.id);
    store.finish(claimed.id, "done");
    // Settled rows no longer hold the key, so a fixed key can run again.
    expect(store.findActiveByIdempotencyKey("nightly-docs")).toBeNull();

    const second = store.enqueue({
      ...base,
      taskKey: "local-next-night",
      taskFile: "/ws/injected/next-night.md",
      idempotencyKey: "nightly-docs",
    });
    expect(second.deduplicated).toBe(false);
    expect(second.task.id).not.toBe(first.task.id);
    expect(second.task.status).toBe("pending");
    expect(second.task.idempotencyKey).toBe("nightly-docs");
    expect(store.findActiveByIdempotencyKey("nightly-docs")?.id).toBe(second.task.id);
    expect(store.list()).toHaveLength(2);
  });

  test("tasks without an idempotency key never dedupe", () => {
    store.enqueue(base);
    store.enqueue({ ...base, taskKey: "local-second", taskFile: "/ws/injected/second.md" });
    expect(store.list()).toHaveLength(2);
  });

  test("finish, requeue, and failRunning settle rows", () => {
    const a = store.enqueue(base);
    store.enqueue({ ...base, taskKey: "local-b", taskFile: "/ws/injected/b.md" });

    const claimedA = store.claimNext()!;
    store.requeue(claimedA.id);
    expect(store.getById(a.task.id)?.status).toBe("pending");

    const claimedAgain = store.claimNext()!;
    store.finish(claimedAgain.id, "done");
    expect(store.getById(claimedAgain.id)?.status).toBe("done");

    const claimedB = store.claimNext()!;
    store.finish(claimedB.id, "failed", "boom");
    const failed = store.getById(claimedB.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toBe("boom");

    // A crashed worker leaves a row running; startup recovery fails it.
    store.enqueue({ ...base, taskKey: "local-c", taskFile: "/ws/injected/c.md" });
    const claimedC = store.claimNext()!;
    const settled = store.failRunning("worker restarted");
    expect(settled.map((task) => task.id)).toEqual([claimedC.id]);
    expect(store.getById(claimedC.id)?.status).toBe("failed");
  });

  test("hasTaskKey detects generated-key collisions", () => {
    store.enqueue(base);
    expect(store.hasTaskKey(base.taskKey)).toBe(true);
    expect(store.hasTaskKey("local-nope")).toBe(false);
  });

  test("requeueSettled revives a settled row under the same key", () => {
    const { task } = store.enqueue(base);
    const claimed = store.claimNext()!;
    store.finish(claimed.id, "failed", "worker restarted while this task was running");

    const revived = store.requeueSettled(base.taskKey);
    expect(revived?.id).toBe(task.id);
    expect(revived?.status).toBe("pending");
    expect(revived?.message).toBeUndefined();
    expect(revived?.startedAt).toBeUndefined();
    expect(revived?.finishedAt).toBeUndefined();
    // The same key (branch/worktree name) is reused, not re-derived.
    expect(revived?.taskKey).toBe(base.taskKey);
    expect(store.claimNext()?.id).toBe(task.id);

    // A row that is already active is never revived twice.
    expect(store.requeueSettled(base.taskKey)).toBeNull();
    // An unknown key settles nothing.
    expect(store.requeueSettled("local-missing")).toBeNull();
  });

  test("getByTaskKey loads the row without claiming it", () => {
    const { task } = store.enqueue(base);
    expect(store.getByTaskKey(base.taskKey)?.id).toBe(task.id);
    expect(store.getByTaskKey(base.taskKey)?.status).toBe("pending");
    expect(store.getByTaskKey("local-missing")).toBeNull();
  });

  test("rejects a duplicate task_key without an idempotency key", () => {
    store.enqueue(base);
    expect(() => store.enqueue({ ...base, taskFile: "/ws/injected/other-path.md" })).toThrow(
      /task_key/,
    );
    expect(store.list()).toHaveLength(1);
  });

  test("autoResume returns a running row to pending while budget remains", () => {
    const { task } = store.enqueue(base);
    const claimed = store.claimNext()!;
    expect(claimed.autoResumeCount).toBe(0);

    const first = store.autoResume(task.id, {
      limit: 1,
      exhaustedMessage: "exhausted",
    });
    expect(first?.resumed).toBe(true);
    expect(first?.task.status).toBe("pending");
    expect(first?.task.autoResumeCount).toBe(1);
    expect(first?.task.startedAt).toBeUndefined();
    expect(first?.task.message).toBeUndefined();

    // The replacement run is claimed, then a second interruption exhausts the
    // durable budget and settles the row failed.
    expect(store.claimNext()?.id).toBe(task.id);
    const second = store.autoResume(task.id, {
      limit: 1,
      exhaustedMessage: "automatic resume budget exhausted",
    });
    expect(second?.resumed).toBe(false);
    expect(second?.task.status).toBe("failed");
    expect(second?.task.message).toBe("automatic resume budget exhausted");
    expect(second?.task.autoResumeCount).toBe(1);
  });

  test("autoResume ignores rows that are not running", () => {
    const { task } = store.enqueue(base);
    expect(store.autoResume(task.id, { limit: 1, exhaustedMessage: "x" })).toBeNull();
    expect(store.getById(task.id)?.status).toBe("pending");
  });

  test("manual requeueSettled resets the automatic-resume budget", () => {
    const { task } = store.enqueue(base);
    store.claimNext();
    store.autoResume(task.id, { limit: 1, exhaustedMessage: "exhausted" });
    store.claimNext();
    store.autoResume(task.id, { limit: 1, exhaustedMessage: "exhausted" });
    expect(store.getById(task.id)?.status).toBe("failed");
    expect(store.getById(task.id)?.autoResumeCount).toBe(1);

    const revived = store.requeueSettled(base.taskKey);
    expect(revived?.status).toBe("pending");
    expect(revived?.autoResumeCount).toBe(0);

    // A manual resume after exhaustion can itself be auto-resumed once more.
    store.claimNext();
    const resumed = store.autoResume(task.id, { limit: 1, exhaustedMessage: "exhausted" });
    expect(resumed?.resumed).toBe(true);
  });

  test("listRunning returns only claimed rows", () => {
    store.enqueue(base);
    store.enqueue({ ...base, taskKey: "local-b", taskFile: "/ws/injected/b.md" });
    const first = store.claimNext()!;
    expect(store.listRunning().map((task) => task.id)).toEqual([first.id]);
  });

  test("records the child pid while running and clears it on settle", () => {
    const { task } = store.enqueue(base);
    store.claimNext();
    store.setChildPid(task.id, 4321, 1_700_000_000_000);
    expect(store.getById(task.id)?.childPid).toBe(4321);
    expect(store.getById(task.id)?.childStartedAt).toBe(1_700_000_000_000);
    store.finish(task.id, "failed", "interrupted");
    expect(store.getById(task.id)?.childPid).toBeUndefined();
    expect(store.getById(task.id)?.childStartedAt).toBeUndefined();
  });

  test("records the child pid while running and clears it on requeue", () => {
    const { task } = store.enqueue(base);
    store.claimNext();
    store.setChildPid(task.id, 4321);
    store.requeue(task.id);
    expect(store.getById(task.id)?.childPid).toBeUndefined();
    expect(store.getById(task.id)?.childStartedAt).toBeUndefined();
    expect(store.getById(task.id)?.status).toBe("pending");
  });

  test("an explicit re-queue keeps the recorded child so the caller can probe it", () => {
    // The manual re-queue guards must be able to see (and refuse) a live child;
    // the next claim overwrites both fields when it spawns its own child.
    const { task } = store.enqueue(base);
    store.claimNext();
    store.setChildPid(task.id, 4321, 1_700_000_000_000);
    // No public setter can settle a row while keeping the pid, so mirror the
    // exact legacy state a pre-upgrade database can hold.
    const raw = new Database(dbPath);
    try {
      raw.run("UPDATE injected_tasks SET status = 'failed' WHERE id = ?", [task.id]);
    } finally {
      raw.close();
    }
    const revived = store.requeueSettled(task.taskKey)!;
    expect(revived.status).toBe("pending");
    expect(revived.childPid).toBe(4321);
    expect(revived.childStartedAt).toBe(1_700_000_000_000);
  });

  test("migrates a database created before auto_resume_count existed", () => {
    const legacyPath = join(dir, "legacy", "queue.db");
    mkdirSync(join(dir, "legacy"), { recursive: true });
    const legacy = new Database(legacyPath);
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
      `INSERT INTO injected_tasks (task_key, repo, title, body, task_file, actor, status, created_at)
       VALUES ('local-legacy', 'backend', 'Legacy', '', '/ws/legacy.md', 'local:add', 'running', 1)`,
    );
    legacy.close();

    const migrated = new InjectedTaskStore(legacyPath);
    try {
      const row = migrated.getByTaskKey("local-legacy");
      expect(row?.autoResumeCount).toBe(0);
      expect(migrated.listRunning()).toHaveLength(1);
    } finally {
      migrated.close();
    }
  });

  test("two openers racing the auto_resume_count migration both succeed", () => {
    const legacyPath = join(dir, "race", "queue.db");
    mkdirSync(join(dir, "race"), { recursive: true });
    const legacy = new Database(legacyPath);
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
    legacy.close();

    const first = new Database(legacyPath);
    const second = new Database(legacyPath);
    const hasColumn = (db: Database) =>
      (db.query("PRAGMA table_info(injected_tasks)").all() as Array<{ name: string }>).some(
        (column) => column.name === "auto_resume_count",
      );
    try {
      // Both connections observe the legacy schema before either migrates,
      // matching two processes that open the shared DB during the same upgrade.
      expect(hasColumn(first)).toBe(false);
      expect(hasColumn(second)).toBe(false);
      addAutoResumeColumn(first);
      // The loser of the ALTER must ignore SQLite's duplicate-column error.
      expect(() => addAutoResumeColumn(second)).not.toThrow();
      expect(hasColumn(second)).toBe(true);
    } finally {
      first.close();
      second.close();
    }

    // The public store still opens the migrated DB normally.
    const migrated = new InjectedTaskStore(legacyPath);
    try {
      expect(migrated.list()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  test("pruneSettled removes settled rows and spares pending/running ones", () => {
    const doneTask = store.enqueue(base);
    store.finish(store.claimNext()!.id, "done");

    store.enqueue({ ...base, taskKey: "local-running", taskFile: "/ws/injected/running.md" });
    store.claimNext();

    store.enqueue({ ...base, taskKey: "local-pending", taskFile: "/ws/injected/pending.md" });

    const pruned = store.pruneSettled(0, Date.now() + 1_000);
    expect(pruned).toBe(1);
    expect(store.getById(doneTask.task.id)).toBeNull();
    expect(
      store
        .list()
        .map((task) => task.taskKey)
        .sort(),
    ).toEqual(["local-pending", "local-running"]);
  });

  test("pruneSettled unlinks each pruned row's prompt file", () => {
    const promptFile = join(dir, "prompt-done.md");
    writeFileSync(promptFile, "sensitive operator context");
    store.enqueue({ ...base, taskFile: promptFile });
    store.finish(store.claimNext()!.id, "done");
    expect(existsSync(promptFile)).toBe(true);

    expect(store.pruneSettled(0, Date.now() + 1_000)).toBe(1);
    expect(existsSync(promptFile)).toBe(false);
  });

  test("pruneSettled tolerates a missing prompt file", () => {
    store.enqueue({ ...base, taskFile: join(dir, "already-gone.md") });
    store.finish(store.claimNext()!.id, "done");

    expect(store.pruneSettled(0, Date.now() + 1_000)).toBe(1);
  });

  test("a closed store never reopens: use after close throws", () => {
    store.enqueue(base);
    store.close();
    expect(store.isClosed()).toBe(true);

    // Before the guard these calls silently reopened the SQLite file (the
    // shutdown race the acquirer now avoids); they must fail loudly instead.
    expect(() => store.getById(1)).toThrow(/closed/i);
    expect(() => store.hasPending()).toThrow(/closed/i);
    expect(() => store.enqueue(base)).toThrow(/closed/i);
    // The one expected post-close caller stays a no-op rather than throwing.
    expect(store.pruneSettled(0)).toBe(0);
  });
});
