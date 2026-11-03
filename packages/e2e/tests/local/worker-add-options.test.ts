import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

interface RepoSpec {
  name: string;
  remote: string;
  defaultBranch: string;
}

function writeWorkspace(dir: string, repos: RepoSpec[]): string {
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "workspace.toml");
  writeFileSync(
    configPath,
    [
      "[workspace]",
      "dashboard = false",
      "",
      "[workspace.execution]",
      'isolation = "best_effort_host"',
      "max_concurrency = 1",
      "max_concurrency_per_repo = 1",
      "",
      "[defaults]",
      'tracker = "markdown"',
      'worker_task_args = "--skip-clarity-check --skip-comments"',
      "",
      ...repos.flatMap((repo) => [
        "[[repos]]",
        `name = "${repo.name}"`,
        `remote = "${repo.remote}"`,
        `default_branch = "${repo.defaultBranch}"`,
        "",
      ]),
    ].join("\n"),
  );
  return configPath;
}

function singleJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

cliTest(
  "worker add enqueues a durable pending task with title, body and JSON",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const title = "Enqueue the greeting";
      const body = "Change the greeting once.\n\nKeep  the double  spaces.";

      const result = await worker.runAdd(["--title", title, "--body", body, "--json"]);

      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = singleJson(result.stdout);
      expect(parsed).toMatchObject({
        repo: worker.repoName,
        status: "pending",
        deduplicated: false,
      });
      expect(parsed.taskKey).toMatch(/^local-/);

      const row = worker.findInjectedTask({ taskKey: String(parsed.taskKey) });
      expect(row).toBeDefined();
      expect(row!.id).toBe(parsed.id as number);
      expect(row!.title).toBe(title);
      expect(row!.body).toBe(body);
      expect(row!.actor).toBe("local:add");
      expect(readFileSync(row!.task_file, "utf8")).toContain(`# ${title}`);
      expect(readFileSync(row!.task_file, "utf8")).toContain(body);
      expect(worker.injectedRows()).toHaveLength(1);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "worker add preserves --body-file and --body-file - bodies exactly",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const fileBody = "  Keep two  spaces\n\nand this newline.\t\nSecond paragraph.";
      const bodyFile = join(worker.root, "body.md");
      writeFileSync(bodyFile, fileBody);

      const fromFile = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "Body from a file",
        "--body-file",
        bodyFile,
        "--json",
      ]);
      expect(fromFile.exitCode, fromFile.stderr).toBe(0);
      const fileResult = singleJson(fromFile.stdout);
      const fileRow = worker.findInjectedTask({ taskKey: String(fileResult.taskKey) });
      expect(fileRow!.body).toBe(fileBody);
      expect(readFileSync(fileRow!.task_file, "utf8")).toContain(fileBody);

      const stdinBody = "From stdin: line one\n\n  indented line two\nDone.";
      const fromStdin = await worker.runAdd(
        ["--repo", worker.repoName, "--title", "Body from stdin", "--body-file", "-", "--json"],
        { stdin: stdinBody },
      );
      expect(fromStdin.exitCode, fromStdin.stderr).toBe(0);
      const stdinResult = singleJson(fromStdin.stdout);
      const stdinRow = worker.findInjectedTask({ taskKey: String(stdinResult.taskKey) });
      expect(stdinRow!.body).toBe(stdinBody);
      expect(readFileSync(stdinRow!.task_file, "utf8")).toContain(stdinBody);
      expect(worker.injectedRows()).toHaveLength(2);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "worker add deduplicates an active idempotency key and releases it after settlement",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const args = [
        "--repo",
        worker.repoName,
        "--title",
        "Nightly docs",
        "--body",
        "Regenerate the docs.",
        "--idempotency-key",
        "e2e-nightly-docs",
        "--json",
      ];

      const first = await worker.runAdd(args);
      expect(first.exitCode, first.stderr).toBe(0);
      const firstResult = singleJson(first.stdout);
      expect(firstResult.deduplicated).toBe(false);

      const second = await worker.runAdd(args);
      expect(second.exitCode, second.stderr).toBe(0);
      const secondResult = singleJson(second.stdout);
      expect(secondResult.deduplicated).toBe(true);
      expect(secondResult.id).toBe(firstResult.id);
      expect(worker.injectedRows()).toHaveLength(1);
      expect(worker.findInjectedTask({ idempotencyKey: "e2e-nightly-docs" })?.id).toBe(
        firstResult.id as number,
      );

      worker.start();
      await worker.waitForReady();
      const settled = await worker.waitForSettled(firstResult.id as number);
      expect(settled.task.status).toBe("done");

      await worker.stop();
      const third = await worker.runAdd(args);
      expect(third.exitCode, third.stderr).toBe(0);
      const thirdResult = singleJson(third.stdout);
      expect(thirdResult.deduplicated).toBe(false);
      expect(thirdResult.id).not.toBe(firstResult.id);

      const rows = worker.injectedRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.status).toBe("done");
      expect(rows[1]?.status).toBe("pending");
      expect(rows[1]?.idempotency_key).toBe("e2e-nightly-docs");
    } finally {
      await worker.dispose();
    }
  },
  180_000,
);

cliTest(
  "worker add --workspace selects the alternate workspace, not the cwd",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const altDir = join(worker.env.HOME, ".devintern-alt");
      const altConfig = writeWorkspace(altDir, [
        {
          name: worker.repoName,
          remote: worker.remote,
          defaultBranch: worker.baseBranch,
        },
      ]);
      const altDb = join(altDir, "state", "queue.db");
      const elsewhere = join(worker.root, "elsewhere");
      mkdirSync(elsewhere);

      const result = await worker.runAdd(
        ["--workspace", altConfig, "--title", "Alternate workspace task", "--json"],
        { cwd: elsewhere },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = singleJson(result.stdout);
      expect(parsed).toMatchObject({
        repo: worker.repoName,
        status: "pending",
        deduplicated: false,
      });

      const altRows = worker.injectedRows(altDb);
      expect(altRows).toHaveLength(1);
      expect(altRows[0]?.task_key).toBe(parsed.taskKey as string);
      expect(altRows[0]?.task_file.startsWith(join(altDir, "injected"))).toBe(true);
      expect(worker.injectedRows()).toHaveLength(0);
      expect(existsSync(worker.dbPath)).toBe(false);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "worker add validation failures exit non-zero and write no row",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const multiDir = join(worker.root, "multi-workspace");
      const multiConfig = writeWorkspace(multiDir, [
        { name: "alpha", remote: worker.remote, defaultBranch: worker.baseBranch },
        { name: "beta", remote: worker.remote, defaultBranch: worker.baseBranch },
      ]);
      const multiDb = join(multiDir, "state", "queue.db");

      const reject = async (args: string[], message: string) => {
        const result = await worker.runAdd(args);
        expect(result.exitCode, result.stderr).not.toBe(0);
        expect(result.stderr).toContain(message);
        return result;
      };

      await reject(["--repo", worker.repoName], "--title is required");
      const unknownRepo = await reject(
        ["--repo", "nope", "--title", "Unknown repo"],
        'Unknown repo "nope"',
      );
      expect(unknownRepo.stderr).toContain(worker.repoName);
      const ambiguous = await reject(
        ["--workspace", multiConfig, "--title", "Ambiguous repo"],
        "--repo is required",
      );
      expect(ambiguous.stderr).toContain("alpha, beta");
      await reject(
        ["--workspace", join(worker.root, "missing", "workspace.toml"), "--title", "No config"],
        "No workspace.toml",
      );
      await reject(
        ["--repo", worker.repoName, "--title", "Oversized body", "--body", "a".repeat(20_001)],
        "Body is too large",
      );
      await reject(
        [
          "--repo",
          worker.repoName,
          "--title",
          "Missing body file",
          "--body-file",
          join(worker.root, "does-not-exist.md"),
        ],
        "Could not read --body-file",
      );
      await reject(
        ["--repo", worker.repoName, "--title", "Bad timeout", "--wait-timeout", "soon"],
        "--wait-timeout",
      );
      await reject(
        ["--repo", worker.repoName, "--title", "Negative timeout", "--wait-timeout", "-1"],
        "--wait-timeout",
      );
      await reject(
        ["--repo", worker.repoName, "--title", "Unknown option", "--bogus"],
        "Unknown option: --bogus",
      );

      for (const conflicting of [
        ["--title", "again"],
        ["--body", "again"],
        ["--body-file", "-"],
        ["--repo", worker.repoName],
        ["--idempotency-key", "again"],
      ]) {
        await reject(["--resume", "local-existing", ...conflicting], "drop --");
      }

      const jsonFailure = await worker.runAdd(["--repo", worker.repoName, "--json"]);
      expect(jsonFailure.exitCode).not.toBe(0);
      // Early validation failures emit no partial object; diagnostics stay on
      // stderr so a caller never parses a half-written stdout line.
      expect(jsonFailure.stdout.trim()).toBe("");
      expect(jsonFailure.stderr).toContain("--title is required");

      expect(worker.injectedRows()).toHaveLength(0);
      expect(worker.injectedRows(multiDb)).toHaveLength(0);
    } finally {
      await worker.dispose();
    }
  },
  180_000,
);

cliTest(
  "worker add --wait waits for the running worker and pushes the branch",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const keepalive = await worker.addTask({
        title: "Keep the worker alive",
        body: "Make the greeting friendlier.",
      });
      worker.start();
      await worker.waitForReady();
      expect((await worker.waitForSettled(keepalive.id)).task.status).toBe("done");

      const result = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "Wait for completion",
        "--body",
        "Change the greeting to Hello, world!",
        "--wait",
        "--json",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = singleJson(result.stdout);
      expect(parsed).toMatchObject({
        status: "done",
        deduplicated: false,
      });

      const taskKey = String(parsed.taskKey);
      expect(worker.findInjectedTask({ taskKey })?.status).toBe("done");
      const runs = worker.runRecords(taskKey);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("succeeded");
      expect(runs[0]?.branch).toBe(`feature/${taskKey}`);
      expect(await worker.branchFile(runs[0]!.branch!, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      // The keepalive plus this task only: --wait never creates a second run.
      expect(worker.runRecords()).toHaveLength(2);
      expect(worker.running).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  240_000,
);

cliTest(
  "worker add --wait fails fast when no worker is running",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const startedAt = Date.now();
      const result = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "No worker",
        "--body",
        "This must not hang.",
        "--wait",
        "--json",
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--wait needs a running worker");
      expect(result.stdout.trim()).toBe("");
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(worker.injectedRows()).toHaveLength(0);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "worker add --wait-timeout 0 waits without a limit and settles normally",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const keepalive = await worker.addTask({
        title: "Keep the worker alive",
        body: "Make the greeting friendlier.",
      });
      worker.start();
      await worker.waitForReady();
      expect((await worker.waitForSettled(keepalive.id)).task.status).toBe("done");

      const result = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "Unlimited wait",
        "--body",
        "Change the greeting to Hello, world!",
        "--wait",
        "--wait-timeout",
        "0",
        "--json",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = singleJson(result.stdout);
      expect(parsed.status).toBe("done");
      const taskKey = String(parsed.taskKey);
      expect(worker.findInjectedTask({ taskKey })?.status).toBe("done");
      expect(worker.runRecords(taskKey)).toHaveLength(1);
    } finally {
      await worker.dispose();
    }
  },
  240_000,
);

cliTest(
  "worker add --wait-timeout 1 emits a terminal timeout object and the task still settles",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      worker.env.E2E_AGENT_DELAY_MS = "3000";
      const slow = await worker.addTask({
        title: "Slow first task",
        body: "Occupy the only repo slot while the waiter times out.",
      });
      worker.start();
      await worker.waitForReady();

      const result = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "Times out waiting",
        "--body",
        "Change the greeting to Hello, world!",
        "--wait",
        "--wait-timeout",
        "1",
        "--json",
      ]);

      expect(result.exitCode).toBe(1);
      const parsed = singleJson(result.stdout);
      expect(parsed).toMatchObject({ status: "failed", deduplicated: false });
      expect(String(parsed.error)).toContain("Timed out after 1s");
      expect(result.stderr).toContain("Timed out after 1s");

      const row = worker.findInjectedTask({ taskKey: String(parsed.taskKey) });
      expect(row).toBeDefined();
      const settled = await worker.waitForSettled(row!.id, 60_000);
      expect(settled.task.status).toBe("done");
      expect(settled.runs).toHaveLength(1);
      expect(settled.runs[0]?.status).toBe("succeeded");
      // The slow task settles too; the timeout never leaves work stuck.
      expect((await worker.waitForSettled(slow.id, 60_000)).task.status).toBe("done");
    } finally {
      await worker.dispose();
    }
  },
  300_000,
);

cliTest(
  "worker add --resume re-queues a settled task on its original branch as a new attempt",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      // An escalated run records the branch, an implementation report, and a
      // landed commit, which is the state session pickup inherits for
      // --resume. Pickup requires commits ahead of the base, so the fixture
      // commits before handing back to a human.
      worker.env.E2E_AGENT_MODE = "incomplete";
      const original = await worker.addTask({
        title: "Resume interrupted task",
        body: "Change the greeting to Hello, world!",
      });
      worker.start();
      await worker.waitForReady();
      const first = await worker.waitForSettled(original.id);
      expect(first.task.status).not.toBe("pending");
      expect(first.task.status).not.toBe("running");
      expect(first.runs).toHaveLength(1);
      const originalBranch = first.runs[0]!.branch;
      expect(originalBranch).toBe(`feature/${original.task_key}`);
      expect(first.runs[0]!.status).toBe("escalated");
      expect(first.runs[0]!.attempt).toBe(1);
      await worker.stop();

      worker.env.E2E_AGENT_MODE = "implement";
      const resumed = await worker.runAdd(["--resume", original.task_key, "--json"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      expect(singleJson(resumed.stdout)).toMatchObject({
        id: original.id,
        taskKey: original.task_key,
        status: "pending",
        deduplicated: false,
      });

      worker.start();
      await worker.waitForReady();
      const settled = await worker.waitForSettled(original.id);
      expect(settled.task.status).toBe("done");
      expect(settled.runs).toHaveLength(2);
      expect(settled.runs[1]?.branch).toBe(originalBranch);
      expect(settled.runs[1]?.attempt).toBe(2);
      expect(settled.runs[1]?.status).toBe("succeeded");
      expect(await worker.branchFile(originalBranch!, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(worker.runRecords()).toHaveLength(2);
    } finally {
      await worker.dispose();
    }
  },
  300_000,
);

cliTest(
  "worker add --resume starts a fresh attempt branch when the prior attempt landed no commits",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      // An escalated run with a report but no landed work: session pickup
      // refuses the empty branch, so the retry gets its own attempt branch.
      worker.env.E2E_AGENT_MODE = "incomplete-empty";
      const original = await worker.addTask({
        title: "Resume an empty branch",
        body: "Change the greeting to Hello, world!",
      });
      worker.start();
      await worker.waitForReady();
      const first = await worker.waitForSettled(original.id);
      expect(first.runs).toHaveLength(1);
      expect(first.runs[0]!.branch).toBe(`feature/${original.task_key}`);
      expect(first.runs[0]!.status).toBe("escalated");
      await worker.stop();

      worker.env.E2E_AGENT_MODE = "implement";
      const resumed = await worker.runAdd(["--resume", original.task_key, "--json"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);

      worker.start();
      await worker.waitForReady();
      const settled = await worker.waitForSettled(original.id);
      expect(settled.task.status).toBe("done");
      expect(settled.runs).toHaveLength(2);
      expect(settled.runs[1]?.branch).toBe(`feature/${original.task_key}-attempt-2`);
      expect(settled.runs[1]?.attempt).toBe(2);
      expect(settled.runs[1]?.status).toBe("succeeded");
    } finally {
      await worker.dispose();
    }
  },
  300_000,
);

cliTest(
  "worker add --resume reports an active task without creating a duplicate",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const task = await worker.addTask({
        title: "Still pending",
        body: "This row has not started yet.",
      });

      const result = await worker.runAdd(["--resume", task.task_key, "--json"]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(singleJson(result.stdout)).toMatchObject({
        id: task.id,
        taskKey: task.task_key,
        status: "pending",
        deduplicated: true,
      });
      expect(result.stderr).toContain("already pending");
      expect(worker.injectedRows()).toHaveLength(1);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "worker add --resume fails clearly for an unknown task key",
  async () => {
    const worker = new WorkerFixture();
    try {
      await worker.prepare();
      const result = await worker.runAdd(["--resume", "local-missing", "--json"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('No ad-hoc task "local-missing"');
      expect(result.stdout.trim()).toBe("");
      expect(worker.injectedRows()).toHaveLength(0);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);
