import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  buildInjectedTaskMarkdown,
  deriveInjectedTaskKey,
  parseWorkerAddArgs,
  runWorkerAdd,
  slugifyTitle,
} from "../src/lib/workspace/add-command";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import { LockManager } from "../src/lib/lock-manager";
import { workspaceDbPath, workspaceWorkerStartPath } from "../src/lib/workspace/paths";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";
import { recoverOrphanedWorkspaceRuns } from "../src/lib/workspace/workspace-worker";
import { InjectedTaskAcquirer } from "../src/lib/workspace/injected-acquirer";
import {
  readProcessStartTime,
  recoverOrphanedInjectedTasks,
} from "../src/lib/workspace/injected-recovery";
import type { TaskExecutionResult } from "../src/lib/acquirers/task-polling";

const WORKSPACE_TOML = `[workspace]
dashboard = false

[defaults]
tracker = "markdown"
worker_task_args = "--no-git"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`;

describe("worker add argument parsing", () => {
  test("parses the documented flags", () => {
    const parsed = parseWorkerAddArgs([
      "--repo",
      "backend",
      "--title",
      "Fix the flake",
      "--body",
      "details",
      "--idempotency-key",
      "run-1",
      "--wait",
      "--json",
    ]);
    expect(parsed).toEqual({
      kind: "ok",
      options: {
        repo: "backend",
        title: "Fix the flake",
        body: "details",
        idempotencyKey: "run-1",
        wait: true,
        json: true,
      },
    });
  });

  test("treats -h/--help as help", () => {
    expect(parseWorkerAddArgs(["--help"]).kind).toBe("help");
    expect(parseWorkerAddArgs(["-h"]).kind).toBe("help");
  });

  test("rejects a missing title, unknown flags, and conflicting body flags", () => {
    expect(parseWorkerAddArgs(["--repo", "backend"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--title", "x", "--nope"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--title", "x", "--body", "a", "--body-file", "b"]).kind).toBe(
      "error",
    );
    expect(parseWorkerAddArgs(["--repo"]).kind).toBe("error");
  });

  test("accepts '-' as the --body-file stdin sentinel", () => {
    const parsed = parseWorkerAddArgs(["--title", "x", "--body-file", "-"]);
    expect(parsed).toMatchObject({ kind: "ok", options: { bodyFile: "-" } });
  });

  test("parses --wait-timeout and rejects non-numeric values", () => {
    expect(parseWorkerAddArgs(["--title", "x", "--wait-timeout", "30"])).toMatchObject({
      kind: "ok",
      options: { waitTimeoutSeconds: 30 },
    });
    expect(parseWorkerAddArgs(["--title", "x", "--wait-timeout", "0"])).toMatchObject({
      kind: "ok",
      options: { waitTimeoutSeconds: 0 },
    });
    expect(parseWorkerAddArgs(["--title", "x", "--wait-timeout", "soon"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--title", "x", "--wait-timeout", "-1"]).kind).toBe("error");
  });

  test("parses --resume and rejects flags that fight the existing row", () => {
    expect(parseWorkerAddArgs(["--resume", "local-fix-flaky-test"])).toMatchObject({
      kind: "ok",
      options: { resume: "local-fix-flaky-test" },
    });
    expect(parseWorkerAddArgs(["--resume", "local-x", "--title", "y"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--resume", "local-x", "--repo", "backend"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--resume", "local-x", "--body", "b"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--resume", "local-x", "--body-file", "-"]).kind).toBe("error");
    expect(parseWorkerAddArgs(["--resume", "local-x", "--idempotency-key", "k"]).kind).toBe(
      "error",
    );
    expect(parseWorkerAddArgs(["--resume"]).kind).toBe("error");
  });
});

describe("worker add key and markdown helpers", () => {
  test("slugifies and derives collision-free local keys", () => {
    expect(slugifyTitle("Fix: Flaky Test (v2)")).toBe("fix-flaky-test-v2");
    const taken = new Set(["local-fix-flaky-test", "local-fix-flaky-test-2"]);
    expect(deriveInjectedTaskKey("Fix flaky test", (key) => taken.has(key))).toBe(
      "local-fix-flaky-test-3",
    );
  });

  test("renders a markdown task with the key in frontmatter", () => {
    const markdown = buildInjectedTaskMarkdown({
      taskKey: "local-bump-deps",
      title: "Bump dependencies",
      body: "Update lockfile.",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(markdown).toContain("key: local-bump-deps");
    expect(markdown).toContain("created_at: 2026-01-02T03:04:05.000Z");
    expect(markdown).toContain("# Bump dependencies");
    expect(markdown).toContain("Update lockfile.");
  });
});

describe("runWorkerAdd", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `worker-add-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "workspace.toml");
    writeFileSync(configPath, WORKSPACE_TOML);
    process.env.DEVINTERN_SKIP_LICENSE_CHECK = "1";
  });

  afterEach(() => {
    delete process.env.DEVINTERN_SKIP_LICENSE_CHECK;
    rmSync(dir, { recursive: true, force: true });
  });

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      options: {
        log: (message: string) => out.push(message),
        error: (message: string) => err.push(message),
        readStdin: () => "piped body\n",
      },
    };
  }

  test("enqueues a durable task for the named repo and emits JSON", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Fix flaky test", "--json"],
      cap.options,
    );
    expect(code).toBe(0);

    const result = JSON.parse(cap.out.at(-1)!);
    expect(result).toMatchObject({
      taskKey: "local-fix-flaky-test",
      repo: "backend",
      status: "pending",
      deduplicated: false,
    });

    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      const task = store.getById(result.id)!;
      expect(task.repo).toBe("backend");
      expect(task.actor).toBe("local:add");
      expect(existsSync(task.taskFile)).toBe(true);
      expect(readFileSync(task.taskFile, "utf8")).toContain("key: local-fix-flaky-test");
    } finally {
      store.close();
    }
  });

  test("writes the prompt owner-only in an owner-only injected directory", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Private prompt", "--json"],
      cap.options,
    );
    expect(code).toBe(0);
    const result = JSON.parse(cap.out.at(-1)!);

    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      const task = store.getById(result.id)!;
      expect(statSync(task.taskFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "injected")).mode & 0o777).toBe(0o700);
    } finally {
      store.close();
    }
  });

  test("reports a clean, actionable error when the workspace state is not writable", async () => {
    // Simulate a sandbox denial: the prompt directory exists but cannot be
    // written. Root ignores mode bits, so skip there.
    if (process.getuid?.() === 0) return;
    const injected = join(dir, "injected");
    mkdirSync(injected, { recursive: true });
    chmodSync(injected, 0o500);
    try {
      const cap = capture();
      const code = await runWorkerAdd(
        ["--workspace", configPath, "--repo", "backend", "--title", "Denied", "--json"],
        cap.options,
      );
      expect(code).toBe(1);
      // --json keeps stdout for a result object; a failure before enqueue has
      // none, and the actionable diagnostics go to stderr instead of a stack.
      expect(cap.out).toHaveLength(0);
      const diagnostics = cap.err.join("\n");
      expect(diagnostics).toContain("Could not enqueue the task");
      expect(diagnostics).toContain("AGENT_SANDBOX_WRITABLE_PATHS");
    } finally {
      chmodSync(injected, 0o700);
    }
  });

  test("--json keeps stdout to a single machine-readable object", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Pure json", "--json"],
      cap.options,
    );
    expect(code).toBe(0);
    // Exactly one line on stdout, and it is the JSON object — the license
    // notice and other diagnostics are routed to stderr.
    expect(cap.out).toHaveLength(1);
    expect(cap.out[0]!.startsWith("{")).toBe(true);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-pure-json",
      repo: "backend",
      status: "pending",
      deduplicated: false,
    });
    expect(cap.err.length).toBeGreaterThan(0);
  });

  test("--resume re-queues a settled task under the same key", async () => {
    const seeded = new InjectedTaskStore(workspaceDbPath(dir));
    const { task } = seeded.enqueue({
      taskKey: "local-interrupted",
      repo: "backend",
      title: "Interrupted task",
      body: "context",
      taskFile: join(dir, "injected", "local-interrupted.md"),
    });
    seeded.finish(seeded.claimNext()!.id, "failed", "worker restarted while this task was running");
    seeded.close();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--resume", "local-interrupted", "--json"],
      cap.options,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.out.at(-1)!)).toMatchObject({
      id: task.id,
      taskKey: "local-interrupted",
      repo: "backend",
      status: "pending",
      deduplicated: false,
    });

    const after = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      const revived = after.getByTaskKey("local-interrupted");
      expect(revived?.status).toBe("pending");
      expect(revived?.message).toBeUndefined();
      expect(revived?.taskFile).toBe(task.taskFile);
    } finally {
      after.close();
    }
  });

  test("--resume refuses while the interrupted attempt's child is still alive", async () => {
    const dbPath = workspaceDbPath(dir);
    const seeded = new InjectedTaskStore(dbPath);
    const { task } = seeded.enqueue({
      taskKey: "local-live-child",
      repo: "backend",
      title: "Live child",
      body: "",
      taskFile: join(dir, "injected", "local-live-child.md"),
    });
    seeded.claimNext();
    seeded.setChildPid(task.id, process.pid, readProcessStartTime(process.pid));
    seeded.close();

    // A pre-upgrade DB can hold a settled row that still names its child;
    // re-queueing it would force-remove the worktree that child is using.
    const raw = new Database(dbPath);
    try {
      raw.run("UPDATE injected_tasks SET status = 'failed' WHERE id = ?", [task.id]);
    } finally {
      raw.close();
    }

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--resume", "local-live-child", "--json"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain(`pid ${process.pid}`);
    expect(cap.err.join("\n")).toContain(
      "If that child finishes successfully, no resume is needed",
    );

    const after = new InjectedTaskStore(dbPath);
    try {
      expect(after.getByTaskKey("local-live-child")?.status).toBe("failed");
    } finally {
      after.close();
    }
  });

  test("--resume reports an active task instead of queueing it twice", async () => {
    const seeded = new InjectedTaskStore(workspaceDbPath(dir));
    const { task } = seeded.enqueue({
      taskKey: "local-active",
      repo: "web",
      title: "Still queued",
      body: "",
      taskFile: join(dir, "injected", "local-active.md"),
    });
    seeded.close();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--resume", "local-active", "--json"],
      cap.options,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.out.at(-1)!)).toMatchObject({
      id: task.id,
      taskKey: "local-active",
      status: "pending",
      deduplicated: true,
    });
    expect(cap.err.join("\n")).toContain("already pending");
  });

  test("--resume fails for an unknown task key", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--resume", "local-missing"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain('No ad-hoc task "local-missing"');
  });

  test("--wait --json emits exactly one object for the settled run", async () => {
    // A live worker lock makes `--wait` proceed.
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    // Settle the row shortly after the command enqueues it, so the wait path
    // observes a transition rather than an already-settled row.
    const settle = (async () => {
      const store = new InjectedTaskStore(workspaceDbPath(dir));
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (store.hasPending()) {
            store.finish(store.claimNext()!.id, "done");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Wait json", "--wait", "--json"],
      cap.options,
    );
    await settle;

    expect(code).toBe(0);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-wait-json",
      status: "done",
      deduplicated: false,
    });
    expect(JSON.parse(cap.out[0]!)).not.toHaveProperty("error");
  });

  test("--wait --json reports a failed row's message in one object", async () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    const settle = (async () => {
      const store = new InjectedTaskStore(workspaceDbPath(dir));
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (store.hasPending()) {
            store.finish(store.claimNext()!.id, "failed", "verification failed");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Failed json",
        "--wait",
        "--json",
      ],
      cap.options,
    );
    await settle;

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-failed-json",
      status: "failed",
      error: "verification failed",
      deduplicated: false,
    });
  });

  test("an idempotent --wait caller reports the failed row reason", async () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    const seed = new InjectedTaskStore(workspaceDbPath(dir));
    seed.enqueue({
      taskKey: "local-existing-failure",
      repo: "backend",
      title: "Existing failure",
      body: "",
      taskFile: join(dir, "injected", "local-existing-failure.md"),
      idempotencyKey: "existing-failure",
    });
    seed.close();

    const settle = (async () => {
      const store = new InjectedTaskStore(workspaceDbPath(dir));
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          const row = store.getByTaskKey("local-existing-failure");
          if (row?.status === "pending") {
            await new Promise((resolve) => setTimeout(resolve, 50));
            const claimed = store.claimNext();
            if (claimed) store.finish(claimed.id, "failed", "existing run failed");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Existing failure",
        "--idempotency-key",
        "existing-failure",
        "--wait",
        "--json",
      ],
      cap.options,
    );
    await settle;
    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      status: "failed",
      error: "existing run failed",
      deduplicated: true,
    });
  });

  test("--wait prints the failed row reason for a human caller", async () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    const settle = (async () => {
      const store = new InjectedTaskStore(workspaceDbPath(dir));
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (store.hasPending()) {
            store.finish(store.claimNext()!.id, "failed", "verification failed");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Failed human", "--wait"],
      cap.options,
    );
    await settle;
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("local-failed-human failed: verification failed");
  });

  test("dedup with --wait keeps the store open until the task settles", async () => {
    const dbPath = workspaceDbPath(dir);
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    // An active row under the idempotency key, so `runWorkerAdd` takes the
    // dedup branch and waits on it.
    const seed = new InjectedTaskStore(dbPath);
    seed.enqueue({
      taskKey: "local-dedup-wait",
      repo: "backend",
      title: "Dedup wait",
      body: "",
      taskFile: join(dir, "injected", "local-dedup-wait.md"),
      idempotencyKey: "dup-wait",
    });
    seed.close();

    // Record the order of `getById`/`close` on the shared prototype, so a
    // premature close (the missing-`await` bug) is observable as a `getById`
    // after the first `close`.
    const events: string[] = [];
    const originalGet = InjectedTaskStore.prototype.getById;
    const originalClose = InjectedTaskStore.prototype.close;
    const getSpy = spyOn(InjectedTaskStore.prototype, "getById").mockImplementation(function (
      this: InjectedTaskStore,
      id: number,
    ) {
      events.push("getById");
      return originalGet.call(this, id);
    });
    const closeSpy = spyOn(InjectedTaskStore.prototype, "close").mockImplementation(
      function (this: InjectedTaskStore) {
        events.push("close");
        return originalClose.call(this);
      },
    );

    let settleStore: InjectedTaskStore | null = null;
    const settle = (async () => {
      settleStore = new InjectedTaskStore(dbPath);
      // Wait until the dedup wait has polled the seeded row before finishing
      // it, so `findActiveByIdempotencyKey` has definitely matched it.
      for (let attempt = 0; attempt < 500 && !events.includes("getById"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const claimed = settleStore.claimNext();
      if (claimed) settleStore.finish(claimed.id, "done");
    })();

    const cap = capture();
    let code: number;
    try {
      code = await runWorkerAdd(
        [
          "--workspace",
          configPath,
          "--repo",
          "backend",
          "--title",
          "Dedup wait",
          "--idempotency-key",
          "dup-wait",
          "--wait",
          "--json",
        ],
        cap.options,
      );
    } finally {
      await settle;
      getSpy.mockRestore();
      closeSpy.mockRestore();
      (settleStore as InjectedTaskStore | null)?.close();
    }

    expect(code).toBe(0);
    expect(JSON.parse(cap.out.at(-1)!)).toMatchObject({
      taskKey: "local-dedup-wait",
      status: "done",
      deduplicated: true,
    });

    const firstClose = events.indexOf("close");
    expect(firstClose).toBeGreaterThanOrEqual(0);
    // Sibling of the bug: the store must not be used after it is closed.
    expect(events.slice(firstClose).every((event) => event === "close")).toBe(true);
  });

  test("--wait recovers a settled run pruned by the retention sweep", async () => {
    const dbPath = workspaceDbPath(dir);
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    // Settle the injected row, then prune it as the retention sweeper would
    // with WORKER_INJECTED_TASK_RETENTION_DAYS=0, so the waiter's next poll
    // finds it gone.
    const prune = (async () => {
      const store = new InjectedTaskStore(dbPath);
      try {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (store.hasPending()) {
            const claimed = store.claimNext()!;
            const runStore = new RunStore(dbPath);
            const runId = runStore.createRun({
              origin: "local",
              taskKey: claimed.taskKey,
              repo: claimed.repo,
            });
            runStore.finishRun(runId, "succeeded");
            runStore.close();
            store.finish(claimed.id, "done");
            store.pruneSettled(0, Date.now() + 1_000);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Pruned run", "--wait", "--json"],
      cap.options,
    );
    await prune;

    expect(code).toBe(0);
    expect(JSON.parse(cap.out.at(-1)!)).toMatchObject({
      taskKey: "local-pruned-run",
      status: "done",
      deduplicated: false,
    });
  });

  test("--wait --json reports a pruned failed run's reason", async () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    const dbPath = workspaceDbPath(dir);
    const prune = (async () => {
      const store = new InjectedTaskStore(dbPath);
      try {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (store.hasPending()) {
            const claimed = store.claimNext()!;
            const runs = new RunStore(dbPath);
            const runId = runs.createRun({
              origin: "local",
              taskKey: claimed.taskKey,
              repo: claimed.repo,
            });
            runs.finishRun(runId, "failed", "pruned run failed");
            runs.close();
            store.finish(claimed.id, "failed", "pruned run failed");
            store.pruneSettled(0, Date.now() + 1_000);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Pruned failed",
        "--wait",
        "--json",
      ],
      cap.options,
    );
    await prune;
    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      status: "failed",
      error: "pruned run failed",
    });
  });

  test("--wait --json rejects another source's run after the row is pruned", async () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    const dbPath = workspaceDbPath(dir);
    const prune = (async () => {
      const store = new InjectedTaskStore(dbPath);
      try {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (store.hasPending()) {
            const claimed = store.claimNext()!;
            const runs = new RunStore(dbPath);
            const unrelated = runs.createRun({
              origin: "task",
              taskKey: claimed.taskKey,
              repo: claimed.repo,
            });
            runs.finishRun(unrelated, "failed", "private unrelated failure");
            runs.close();
            store.finish(claimed.id, "failed", "task pipeline did not complete cleanly");
            store.pruneSettled(0, Date.now() + 1_000);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        store.close();
      }
    })();
    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Pruned wrong source",
        "--wait",
        "--json",
      ],
      cap.options,
    );
    await prune;
    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("disappeared while waiting"),
    });
    expect(cap.out[0]).not.toContain("private unrelated failure");
  });

  test("--wait-timeout bounds a wait the live worker never settles", async () => {
    // The worker lock is present, but nothing ever claims/settles the row — the
    // exact shape of a usage-limit pause or a permanently saturated repo.
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Stuck",
        "--wait",
        "--wait-timeout",
        "1",
      ],
      cap.options,
    );

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("Timed out after 1s");
    expect(cap.err.join("\n")).toContain("--wait-timeout");
  });

  test("--wait-timeout --json still emits a single terminal error object", async () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Stuck json",
        "--wait",
        "--wait-timeout",
        "1",
        "--json",
      ],
      cap.options,
    );

    expect(code).toBe(1);
    // Exactly one object on stdout, so `… --wait --json | jq .` still parses.
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-stuck-json",
      repo: "backend",
      status: "failed",
      deduplicated: false,
    });
    expect(JSON.parse(cap.out[0]!).error).toContain("Timed out after 1s");
    expect(cap.err.join("\n")).toContain("Timed out after 1s");
  });

  test("--wait --json emits a terminal error object when the worker stops", async () => {
    // The pre-flight check sees a live worker; every poll after that sees it
    // gone, so the waiter must report the failure as one JSON object.
    const lockSpy = spyOn(LockManager, "readLockStatus").mockReturnValue({ running: false });
    lockSpy.mockReturnValueOnce({ running: true });

    const cap = capture();
    let code: number;
    try {
      code = await runWorkerAdd(
        ["--workspace", configPath, "--repo", "backend", "--title", "Stopped", "--wait", "--json"],
        cap.options,
      );
    } finally {
      lockSpy.mockRestore();
    }

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-stopped",
      repo: "backend",
      status: "failed",
      deduplicated: false,
    });
    expect(JSON.parse(cap.out[0]!).error).toContain("worker stopped");
    expect(cap.err.join("\n")).toContain("worker stopped");
  });

  test("--wait --json emits a terminal error object when the row disappears", async () => {
    const dbPath = workspaceDbPath(dir);
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    // Settle then prune the row with no run record, so the waiter's next poll
    // finds it gone and the outcome is genuinely inconclusive.
    const wipe = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      try {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (seed.hasPending()) {
            seed.finish(seed.claimNext()!.id, "done");
            seed.pruneSettled(0, Date.now() + 1_000);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        seed.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Vanished", "--wait", "--json"],
      cap.options,
    );
    await wipe;

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-vanished",
      status: "failed",
      deduplicated: false,
    });
    expect(JSON.parse(cap.out[0]!).error).toContain("disappeared");
  });

  test("enqueue survives restart recovery and is drained by the acquirer", async () => {
    const dbPath = workspaceDbPath(dir);

    // A task the previous worker had claimed and then died on.
    const seed = new InjectedTaskStore(dbPath);
    seed.enqueue({
      taskKey: "local-running",
      repo: "backend",
      title: "Running",
      body: "",
      taskFile: join(dir, "injected", "local-running.md"),
    });
    seed.claimNext();
    seed.close();

    // Enqueue the durable pending task through the public command.
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Durable one", "--json"],
      cap.options,
    );
    expect(code).toBe(0);
    const enqueued = JSON.parse(cap.out.at(-1)!);

    // Restart recovery: pending survives, the dead worker's running row fails.
    await recoverOrphanedWorkspaceRuns({
      config: loadWorkspaceConfig(configPath),
      workspaceDir: dir,
      dbPath,
    });
    // Injected-row recovery runs post-lock in the real startup path.
    const recovery = new InjectedTaskStore(dbPath);
    try {
      await recoverOrphanedInjectedTasks(recovery);
    } finally {
      recovery.close();
    }

    const after = new InjectedTaskStore(dbPath);
    try {
      expect(after.getById(enqueued.id)?.status).toBe("pending");
      expect(after.list().find((task) => task.taskKey === "local-running")?.status).toBe("failed");
    } finally {
      after.close();
    }

    // A fresh worker's acquirer drains the surviving row from the same DB.
    const drain = new InjectedTaskStore(dbPath);
    const calls: string[] = [];
    const acquirer = new InjectedTaskAcquirer({
      store: drain,
      execute: async (task) => {
        calls.push(task.taskKey);
        return true as TaskExecutionResult;
      },
      intervalSeconds: 3600,
    });
    try {
      await acquirer.tick();
    } finally {
      drain.close();
    }
    expect(calls).toEqual([enqueued.taskKey]);
  });

  test("restart recovery auto-resumes a resumable running injected row", async () => {
    const dbPath = workspaceDbPath(dir);
    const runs = new RunStore(dbPath);
    const runId = runs.createRun({
      origin: "local",
      taskKey: "local-resumable",
      tracker: "local",
      repo: "backend",
      branch: "feature/local-resumable",
    });
    runs.addStage(
      runId,
      "implementation",
      "succeeded",
      undefined,
      JSON.stringify({ report: "prior work" }),
    );
    runs.finishRun(runId, "failed", "interrupted");

    const seed = new InjectedTaskStore(dbPath);
    seed.enqueue({
      taskKey: "local-resumable",
      repo: "backend",
      title: "Resumable",
      body: "",
      taskFile: join(dir, "injected", "local-resumable.md"),
    });
    const claimed = seed.claimNext()!;

    try {
      await recoverOrphanedInjectedTasks(seed, {
        runStore: runs,
        branchExists: () => true,
      });
      expect(seed.getById(claimed.id)?.status).toBe("pending");
      expect(seed.getById(claimed.id)?.autoResumeCount).toBe(1);
    } finally {
      seed.close();
      runs.close();
    }
  });

  test("--wait keeps waiting across an automatic resume and reports success", async () => {
    const dbPath = workspaceDbPath(dir);
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const worker = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      const runs = new RunStore(dbPath);
      try {
        let taskKey: string | undefined;
        for (let attempt = 0; attempt < 300; attempt++) {
          const row = seed.list().find((task) => task.status === "pending");
          if (row) {
            taskKey = row.taskKey;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!taskKey) throw new Error("timed out waiting for the enqueued row");

        seed.claimNext();
        const runId = runs.createRun({
          origin: "local",
          taskKey,
          tracker: "local",
          repo: "backend",
          branch: `feature/${taskKey}`,
        });
        runs.addStage(
          runId,
          "implementation",
          "succeeded",
          undefined,
          JSON.stringify({ report: "prior work" }),
        );
        runs.finishRun(runId, "failed", "interrupted");

        await recoverOrphanedInjectedTasks(seed, {
          runStore: runs,
          branchExists: () => true,
        });

        // Replacement run settles successfully.
        const replacement = seed.claimNext();
        if (!replacement) throw new Error("row was not auto-resumed");
        seed.finish(replacement.id, "done");
      } finally {
        seed.close();
        runs.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Wait auto", "--wait", "--json"],
      cap.options,
    );
    await worker;

    expect(code).toBe(0);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-wait-auto",
      status: "done",
      deduplicated: false,
    });
  });

  test("--wait exits non-zero when the replacement run after an automatic resume fails", async () => {
    const dbPath = workspaceDbPath(dir);
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const worker = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      const runs = new RunStore(dbPath);
      try {
        let taskKey: string | undefined;
        for (let attempt = 0; attempt < 300; attempt++) {
          const row = seed.list().find((task) => task.status === "pending");
          if (row) {
            taskKey = row.taskKey;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!taskKey) throw new Error("timed out waiting for the enqueued row");

        seed.claimNext();
        const runId = runs.createRun({
          origin: "local",
          taskKey,
          tracker: "local",
          repo: "backend",
          branch: `feature/${taskKey}`,
        });
        runs.addStage(
          runId,
          "implementation",
          "succeeded",
          undefined,
          JSON.stringify({ report: "prior work" }),
        );
        runs.finishRun(runId, "failed", "interrupted");

        await recoverOrphanedInjectedTasks(seed, {
          runStore: runs,
          branchExists: () => true,
        });

        const replacement = seed.claimNext();
        if (!replacement) throw new Error("row was not auto-resumed");
        seed.finish(replacement.id, "failed", "replacement run failed");
      } finally {
        seed.close();
        runs.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Wait auto fail",
        "--wait",
        "--json",
      ],
      cap.options,
    );
    await worker;

    expect(code).toBe(1);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-wait-auto-fail",
      status: "failed",
      deduplicated: false,
    });
  });

  test("--wait keeps waiting while a running task's worker restarts", async () => {
    const dbPath = workspaceDbPath(dir);
    const lockPath = join(dir, ".worker.lock");
    const writeLock = () =>
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      );
    writeLock();

    const companion = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      try {
        let pending: { id: number } | undefined;
        for (let attempt = 0; attempt < 300; attempt++) {
          pending = seed.list().find((task) => task.status === "pending");
          if (pending) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!pending) throw new Error("timed out waiting for the enqueued row");

        const claimed = seed.claimNext()!;
        // Simulate the restart gap: the worker lock disappears while the task
        // is still claimed, then a replacement worker takes over.
        rmSync(lockPath, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        writeLock();
        seed.finish(claimed.id, "done");
      } finally {
        seed.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Wait restart",
        "--wait",
        "--json",
      ],
      cap.options,
    );
    await companion;

    expect(code).toBe(0);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-wait-restart",
      status: "done",
    });
    expect(cap.err.join("\n")).toContain("may auto-resume when the worker restarts");
  });

  test("--wait does not count a live replacement's pre-lock startup against the grace", async () => {
    const dbPath = workspaceDbPath(dir);
    const lockPath = join(dir, ".worker.lock");
    const writeLock = () =>
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      );
    writeLock();

    const companion = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      try {
        let pending: { id: number } | undefined;
        for (let attempt = 0; attempt < 300; attempt++) {
          pending = seed.list().find((task) => task.status === "pending");
          if (pending) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!pending) throw new Error("timed out waiting for the enqueued row");

        const claimed = seed.claimNext()!;
        rmSync(lockPath, { force: true });
        // The replacement process is alive but still doing pre-lock startup
        // (orphan recovery, worktree sweep, push probes) for longer than the
        // test's restart grace. Its marker must hold the grace open.
        writeFileSync(
          workspaceWorkerStartPath(dir),
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        writeLock();
        seed.finish(claimed.id, "done");
      } finally {
        seed.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Wait startup",
        "--wait",
        "--json",
      ],
      { ...cap.options, restartGraceMs: 300 },
    );
    await companion;

    expect(code).toBe(0);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-wait-startup",
      status: "done",
    });
  });

  test("--wait keeps a pending task during a live replacement's pre-lock startup", async () => {
    const dbPath = workspaceDbPath(dir);
    const lockPath = join(dir, ".worker.lock");
    const writeLock = () =>
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      );
    writeLock();

    const companion = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      try {
        let pending: { id: number } | undefined;
        for (let attempt = 0; attempt < 300; attempt++) {
          pending = seed.list().find((task) => task.status === "pending");
          if (pending) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!pending) throw new Error("timed out waiting for the enqueued row");

        // The previous worker died before claiming the queued row; the
        // replacement is alive but still doing pre-lock startup for longer than
        // the test's restart grace. `--wait` must keep waiting (the row will be
        // claimed) instead of reporting a transient restart as a failure.
        rmSync(lockPath, { force: true });
        writeFileSync(
          workspaceWorkerStartPath(dir),
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        writeLock();
        const claimed = seed.claimNext()!;
        seed.finish(claimed.id, "done");
      } finally {
        seed.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Wait pending startup",
        "--wait",
        "--json",
      ],
      { ...cap.options, restartGraceMs: 300 },
    );
    await companion;

    expect(code).toBe(0);
    expect(JSON.parse(cap.out[0]!)).toMatchObject({
      taskKey: "local-wait-pending-startup",
      status: "done",
    });
    expect(cap.err.join("\n")).not.toContain("The worker stopped before the task finished");
  });

  test("--wait still fails fast on a pending task when no replacement is starting", async () => {
    const dbPath = workspaceDbPath(dir);
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const companion = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      try {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (seed.hasPending()) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The worker dies with the row still queued and never comes back.
        rmSync(join(dir, ".worker.lock"), { force: true });
      } finally {
        seed.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Queued dead",
        "--wait",
        "--json",
      ],
      { ...cap.options, restartGraceMs: 300 },
    );
    await companion;

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("The worker stopped before the task finished");
  });

  test("--wait fails after the restart grace when the worker never returns", async () => {
    const dbPath = workspaceDbPath(dir);
    const lockPath = join(dir, ".worker.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const companion = (async () => {
      const seed = new InjectedTaskStore(dbPath);
      try {
        let pending: { id: number } | undefined;
        for (let attempt = 0; attempt < 300; attempt++) {
          pending = seed.list().find((task) => task.status === "pending");
          if (pending) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!pending) throw new Error("timed out waiting for the enqueued row");

        seed.claimNext();
        // The worker dies permanently: the row stays `running` and no
        // replacement process ever takes the lock back.
        rmSync(lockPath, { force: true });
      } finally {
        seed.close();
      }
    })();

    const cap = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Dead worker",
        "--wait",
        "--json",
      ],
      { ...cap.options, restartGraceMs: 1_000 },
    );
    await companion;

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0]!).error).toContain("did not restart within 1s");
    expect(cap.err.join("\n")).toContain("did not restart within 1s");
  });

  test("reads the body from stdin for --body-file -", async () => {
    const cap = capture();
    await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "Piped",
        "--body-file",
        "-",
        "--json",
      ],
      cap.options,
    );
    const result = JSON.parse(cap.out.at(-1)!);
    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      expect(store.getById(result.id)!.body).toBe("piped body\n");
    } finally {
      store.close();
    }
  });

  test("defaults to the only repo and is idempotent on the key", async () => {
    writeFileSync(
      configPath,
      WORKSPACE_TOML.replace(/\n\[\[repos\]\]\nname = "web"[\s\S]*$/, "\n"),
    );
    const cap = capture();
    const args = [
      "--workspace",
      configPath,
      "--title",
      "Bump deps",
      "--idempotency-key",
      "nightly-42",
      "--json",
    ];
    await runWorkerAdd(args, cap.options);
    const first = JSON.parse(cap.out.at(-1)!);
    expect(first.repo).toBe("backend");

    const second = capture();
    await runWorkerAdd(args, second.options);
    const dedup = JSON.parse(second.out.at(-1)!);
    expect(dedup.deduplicated).toBe(true);
    expect(dedup.id).toBe(first.id);

    const store = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      expect(store.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("re-enqueues a fixed idempotency key once the previous task settled", async () => {
    const args = [
      "--workspace",
      configPath,
      "--repo",
      "backend",
      "--title",
      "Nightly docs",
      "--idempotency-key",
      "nightly-docs",
      "--json",
    ];

    const first = capture();
    await runWorkerAdd(args, first.options);
    const firstResult = JSON.parse(first.out.at(-1)!);

    const settle = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      settle.finish(settle.claimNext()!.id, "done");
    } finally {
      settle.close();
    }

    const second = capture();
    const code = await runWorkerAdd(args, second.options);
    expect(code).toBe(0);
    const secondResult = JSON.parse(second.out.at(-1)!);
    expect(secondResult.deduplicated).toBe(false);
    expect(secondResult.id).not.toBe(firstResult.id);

    const verify = new InjectedTaskStore(workspaceDbPath(dir));
    try {
      expect(verify.list()).toHaveLength(2);
    } finally {
      verify.close();
    }
  });

  test("fails clearly for an unknown repo and lists valid names", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "nope", "--title", "x"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain('Unknown repo "nope"');
    expect(cap.err.join("\n")).toContain("backend, web");
  });

  test("fails clearly when --repo is omitted with multiple repos", async () => {
    const cap = capture();
    const code = await runWorkerAdd(["--workspace", configPath, "--title", "x"], cap.options);
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("--repo is required");
    expect(cap.err.join("\n")).toContain("backend, web");
  });

  test("rejects an empty title and an oversized body", async () => {
    const empty = capture();
    expect(await runWorkerAdd(["--workspace", configPath, "--title", "   "], empty.options)).toBe(
      1,
    );
    expect(empty.err.join("\n")).toContain("--title is required");

    const big = capture();
    const code = await runWorkerAdd(
      [
        "--workspace",
        configPath,
        "--repo",
        "backend",
        "--title",
        "x",
        "--body",
        "a".repeat(20_001),
      ],
      big.options,
    );
    expect(code).toBe(1);
    expect(big.err.join("\n")).toContain("Body is too large");
  });

  test("fails when the workspace has no workspace.toml", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", join(dir, "missing", "workspace.toml"), "--title", "x"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("No workspace.toml");
  });

  test("--wait fails fast when no worker is running", async () => {
    const cap = capture();
    const code = await runWorkerAdd(
      ["--workspace", configPath, "--repo", "backend", "--title", "Wait", "--wait"],
      cap.options,
    );
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("--wait needs a running worker");
  });
});
