import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureWorkspace } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";

class ExposedWorkspace extends FixtureWorkspace {
  pointAt(taskKey: string): void {
    this.useTaskKey(taskKey);
  }

  adopt(branch: string): void {
    this.adoptHead(branch);
  }
}

test("feature branch, task key and owned branches derive from the actual tracker key", () => {
  const run = new ExposedWorkspace();
  try {
    expect(run.taskKey).toBe(run.id);
    expect(run.head).toBe(`feature/${run.id}`);
    expect(run.ownedBranches.has(run.base)).toBe(true);
    expect(run.ownedBranches.has(run.head)).toBe(true);

    run.pointAt("12345");
    expect(run.taskKey).toBe("12345");
    expect(run.head).toBe("feature/12345");
    expect(run.ownedBranches.has("feature/12345")).toBe(true);
    // The synthetic Markdown branch is replaced, not merely supplemented.
    expect(run.ownedBranches.has(`feature/${run.id}`)).toBe(false);
    expect(() => run.pointAt("   ")).toThrow("empty");
  } finally {
    run.dispose();
  }
});

test("adoptHead replaces the derived head so cleanup never owns a foreign ref", () => {
  const run = new ExposedWorkspace();
  try {
    run.pointAt("2");
    expect(run.head).toBe("feature/2");
    expect(run.ownedBranches.has("feature/2")).toBe(true);

    // A collision pushed the CLI to an attempt branch: ownership must move to
    // the branch the run actually created, releasing the deterministic ref.
    run.adopt("feature/2-attempt-2");
    expect(run.head).toBe("feature/2-attempt-2");
    expect(run.ownedBranches.has("feature/2-attempt-2")).toBe(true);
    expect(run.ownedBranches.has("feature/2")).toBe(false);

    // Adopting the already-derived head is a no-op.
    run.adopt("feature/2-attempt-2");
    expect(run.ownedBranches.has("feature/2-attempt-2")).toBe(true);
    expect(() => run.adopt("   ")).toThrow("empty");
  } finally {
    run.dispose();
  }
});

test("useTaskKey drops a previously adopted head when the key changes", () => {
  const run = new ExposedWorkspace();
  try {
    run.pointAt("2");
    run.adopt("feature/2-attempt-2");
    run.pointAt("3");
    expect(run.head).toBe("feature/3");
    expect(run.ownedBranches.has("feature/2-attempt-2")).toBe(false);
    expect(run.ownedBranches.has("feature/3")).toBe(true);
  } finally {
    run.dispose();
  }
});

test("recordedBranch reads the latest branch the run stored for the task key", () => {
  const run = new ExposedWorkspace();
  try {
    const db = new Database(run.env.WEBHOOK_QUEUE_DB);
    db.run("CREATE TABLE runs (id INTEGER PRIMARY KEY, task_key TEXT, branch TEXT)");
    db.run("INSERT INTO runs (task_key, branch) VALUES ('2', 'feature/2-attempt-2')");
    db.run("INSERT INTO runs (task_key, branch) VALUES ('2', 'feature/2-attempt-3')");
    db.run("INSERT INTO runs (task_key, branch) VALUES ('9', 'feature/9')");
    db.run("INSERT INTO runs (task_key, branch) VALUES ('10', NULL)");
    db.close();

    expect(run.recordedBranch("2")).toBe("feature/2-attempt-3");
    expect(run.recordedBranch("9")).toBe("feature/9");
    expect(run.recordedBranch("10")).toBeUndefined();
    expect(run.recordedBranch("404")).toBeUndefined();
  } finally {
    run.dispose();
  }
});

test("recordedBranch is undefined when no run-records database exists yet", () => {
  const run = new ExposedWorkspace();
  try {
    expect(run.recordedBranch("2")).toBeUndefined();
  } finally {
    run.dispose();
  }
});

test("recordedBranch is undefined when the run-records database cannot be opened", () => {
  const run = new ExposedWorkspace();
  try {
    // A directory at the database path makes the sqlite constructor itself
    // throw, proving the best-effort contract covers open failures too.
    mkdirSync(run.env.WEBHOOK_QUEUE_DB);
    expect(run.recordedBranch("2")).toBeUndefined();
  } finally {
    run.dispose();
  }
});

test("prepare exposes a leftover remote-only feature branch so the CLI can avoid it", async () => {
  const run = new FixtureWorkspace();
  const remote = join(run.root, "remote.git");
  const seed = join(run.root, "seed");
  try {
    await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
    // Seed a foreign `feature/2` on the shared remote before the fixture
    // workspace is prepared, mimicking a previous run that left it behind.
    mkdirSync(seed, { recursive: true });
    await checkedCommand(["git", "init", "--initial-branch", "seed"], seed, run.env);
    writeFileSync(join(seed, "foreign.txt"), "left over from a previous run\n");
    await checkedCommand(["git", "add", "."], seed, run.env);
    await checkedCommand(["git", "commit", "-m", "prior attempt"], seed, run.env);
    await checkedCommand(["git", "remote", "add", "origin", remote], seed, run.env);
    await checkedCommand(["git", "push", "origin", "seed"], seed, run.env);
    await checkedCommand(["git", "checkout", "-b", "feature/2"], seed, run.env);
    await checkedCommand(["git", "push", "origin", "feature/2"], seed, run.env);

    await run.prepare(remote, "test-token", {});

    // The leftover ref must be a local remote-tracking ref: the CLI's
    // collision detection only consults local and `origin/*` refs, so without
    // it the run recreates the foreign `feature/2` and the push is rejected
    // instead of falling back to `feature/2-attempt-2`. `show-ref --verify`
    // exits non-zero (and `run.git` throws) when the ref is absent.
    expect(await run.git("show-ref", "--verify", "refs/remotes/origin/feature/2")).toContain(
      "refs/remotes/origin/feature/2",
    );
  } finally {
    run.dispose();
  }
});

test("all-task run records expose an accidentally processed decoy", () => {
  const run = new ExposedWorkspace();
  try {
    run.pointAt("2");
    const db = new Database(run.env.WEBHOOK_QUEUE_DB);
    db.run(
      "CREATE TABLE runs (id INTEGER PRIMARY KEY, task_key TEXT, tracker TEXT, status TEXT, pr_url TEXT, outcome_reason TEXT)",
    );
    db.run(
      "INSERT INTO runs (task_key, tracker, status) VALUES ('2', 'gitlab', 'succeeded'), ('1', 'gitlab', 'failed')",
    );
    db.close();
    expect(run.runRecords().map((record) => record.task_key)).toEqual(["2"]);
    expect(run.runRecords({ allTasks: true }).map((record) => record.task_key)).toEqual(["2", "1"]);
  } finally {
    run.dispose();
  }
});
