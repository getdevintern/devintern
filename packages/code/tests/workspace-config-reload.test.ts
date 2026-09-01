import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  WorkspaceConfigReloader,
  applyWorkspaceConfig,
  serializeWorkspaceConfig,
} from "../src/lib/workspace/config-reload";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoConfig, WorkspaceConfig } from "../src/lib/workspace/config";
import type { RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import {
  createFleetTaskExecutor,
  resolveFleetAutomations,
} from "../src/lib/workspace/workspace-worker";
import { toRoutableTask } from "../src/lib/workspace/router";

const V1 = `
[defaults]
tracker = "markdown"
task_query = "status=todo"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "backend"
labels = ["backend"]
`;

const V2 = `
[defaults]
tracker = "markdown"
task_query = "status=todo"
worker_task_args = "--create-pr --fast"
poll_interval = 15

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "frontend"
labels = ["backend"]

[[automations]]
id = "sweep"
enabled = true
interval = "1h"
prompt = "Tidy up."
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = join(tmpdir(), `reload-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function writeToml(path: string, text: string): void {
  writeFileSync(path, text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

describe("WorkspaceConfigReloader", () => {
  test("applies edited workspace.toml to the shared config instance", () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V1);
    const current: WorkspaceConfig = parseWorkspaceConfig(readFileSync(path, "utf8"));
    const reloader = new WorkspaceConfigReloader({ configPath: path, current });

    expect(reloader.reload("test").applied).toBe(false);

    writeToml(path, V2);
    const outcome = reloader.reload("test");
    expect(outcome.applied).toBe(true);
    // The same instance every consumer holds was mutated in place.
    expect(current.repos).toHaveLength(2);
    expect(current.defaults.pollIntervalSeconds).toBe(15);
    expect(current.routing).toHaveLength(1);
    expect(current.routing[0]?.repo).toBe("frontend");
    expect(current.automations.map((automation) => automation.id)).toEqual(["sweep"]);
  });

  test("copies scheduled estimations into the shared config", () => {
    const current = parseWorkspaceConfig(V1);
    const next = parseWorkspaceConfig(V2);
    next.estimations = [
      {
        id: "groom",
        enabled: true,
        query: "status=todo",
        interval: "1h",
        intervalMs: 3_600_000,
      },
    ];

    applyWorkspaceConfig(current, next);

    expect(current.estimations.map((item) => item.id)).toEqual(["groom"]);
  });

  test("rejects runtime-incompatible changes before mutating active config", () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V2);
    const current = parseWorkspaceConfig(V1);
    const errors: string[] = [];
    const reloader = new WorkspaceConfigReloader({
      configPath: path,
      current,
      validate: () => {
        throw new Error("tracker is startup-only");
      },
      onError: (message) => errors.push(message),
    });

    expect(reloader.reload("test").applied).toBe(false);
    expect(current.defaults.pollIntervalSeconds).toBe(60);
    expect(errors[0]).toContain("tracker is startup-only");
  });

  test("keeps the last good config when a reload produces invalid TOML", () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V2);
    const current: WorkspaceConfig = parseWorkspaceConfig(readFileSync(path, "utf8"));
    const errors: string[] = [];
    const reloader = new WorkspaceConfigReloader({
      configPath: path,
      current,
      onError: (message) => errors.push(message),
    });

    writeToml(path, "[[repos]\nname = broken");
    const outcome = reloader.reload("mid-edit save");

    expect(outcome.applied).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Failed to reload workspace config (mid-edit save)");
    expect(errors[0]).toContain(path);
    // Still serving the previous configuration.
    expect(current.repos).toHaveLength(2);
    expect(current.defaults.pollIntervalSeconds).toBe(15);
  });

  test("keeps the last good config on semantic errors and surfaces them", () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V2);
    const current: WorkspaceConfig = parseWorkspaceConfig(readFileSync(path, "utf8"));
    const errors: string[] = [];
    const reloader = new WorkspaceConfigReloader({
      configPath: path,
      current,
      onError: (message) => errors.push(message),
    });

    writeToml(
      path,
      `${V2}\n[[repos]]\nname = "frontend"\nremote = "git@github.com:acme/other.git"\n`,
    );
    const outcome = reloader.reload("bad edit");

    expect(outcome.applied).toBe(false);
    expect(errors.join("\n")).toContain("Duplicate repo name");
    expect(current.repos).toHaveLength(2);
  });

  test("treats rewriting identical content as a no-op", () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V2);
    const current: WorkspaceConfig = parseWorkspaceConfig(readFileSync(path, "utf8"));
    const reloader = new WorkspaceConfigReloader({ configPath: path, current });

    writeToml(path, V2);
    const outcome = reloader.reload("identical rewrite");
    expect(outcome.applied).toBe(false);
    expect(outcome.unchanged).toBe(true);
  });

  test("serializations of equal configs match regardless of parse instance", () => {
    const first = parseWorkspaceConfig(V2);
    const second = parseWorkspaceConfig(V2);
    expect(serializeWorkspaceConfig(first)).toBe(serializeWorkspaceConfig(second));
    expect(serializeWorkspaceConfig(first)).not.toBe(
      serializeWorkspaceConfig(parseWorkspaceConfig(V1)),
    );
  });

  test("coalesces rapid successive edits into one reload", async () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V1);
    const current: WorkspaceConfig = parseWorkspaceConfig(readFileSync(path, "utf8"));
    let loads = 0;
    const reloader = new WorkspaceConfigReloader({
      configPath: path,
      current,
      debounceMs: 25,
      load: (p) => {
        loads += 1;
        return parseWorkspaceConfig(readFileSync(p, "utf8"));
      },
    });

    reloader.scheduleReload("edit 1");
    await sleep(5);
    reloader.scheduleReload("edit 2");
    reloader.scheduleReload("edit 3");
    expect(loads).toBe(0);

    await waitFor(() => loads === 1);
    await sleep(50);
    expect(loads).toBe(1);
  });

  test("watches the file and applies edits while running; SIGHUP still works after stopping", async () => {
    const dir = freshDir();
    const path = join(dir, "workspace.toml");
    writeToml(path, V1);
    const current: WorkspaceConfig = parseWorkspaceConfig(readFileSync(path, "utf8"));
    const reloader = new WorkspaceConfigReloader({
      configPath: path,
      current,
      debounceMs: 20,
    });

    reloader.start();

    // Automatic file watching: an edit applies within the debounce window.
    writeToml(path, V2);
    await waitFor(() => current.defaults.pollIntervalSeconds === 15);
    expect(current.repos).toHaveLength(2);
    expect(current.automations).toHaveLength(1);

    // Stop() tears down the watcher but the daemon-lifetime SIGHUP fallback
    // keeps working for manual reloads.
    reloader.stop();
    writeToml(path, V1);
    process.kill(process.pid, "SIGHUP");
    await waitFor(() => current.defaults.pollIntervalSeconds === 60);
    expect(current.repos).toHaveLength(2);
    expect(current.automations).toHaveLength(0);
  });
});

describe("resolveFleetAutomations", () => {
  test("requires repo targeting once the fleet has multiple repos", () => {
    const withProblem = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[repos]]
name = "one"
remote = "git@github.com:acme/one.git"

[[repos]]
name = "two"
remote = "git@github.com:acme/two.git"

[[automations]]
id = "loose"
enabled = true
interval = "1h"
prompt = "p"
`);
    const result = resolveFleetAutomations(withProblem);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('"loose"');
    expect(result.problems[0]).toContain("must set repo");
    expect(result.automations).toHaveLength(0);

    // A single-repo workspace implies its only checkout.
    const single = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"

[[repos]]
name = "only"
remote = "git@github.com:acme/only.git"

[[automations]]
id = "implicit"
enabled = true
interval = "1h"
prompt = "p"
`);
    const okResult = resolveFleetAutomations(single);
    expect(okResult.problems).toHaveLength(0);
    expect(okResult.automations).toHaveLength(1);
  });
});

describe("createFleetTaskExecutor with live-reloaded config", () => {
  class StubRepoManager implements RepoManagerLike {
    worktrees: string[] = [];
    constructor(private root: string) {}
    async ensureBareClone(): Promise<string> {
      return this.root;
    }
    async fetch(): Promise<void> {}
    async ensureBaseWorktree(repo: RepoConfig): Promise<string> {
      return join(this.root, "worktrees", repo.name, "base");
    }
    async createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string> {
      const path = join(this.root, "worktrees", repo.name, taskKey.toLowerCase());
      this.worktrees.push(path);
      return path;
    }
    async removeTaskWorktree(_repoName: string, worktreePath: string): Promise<void> {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    async sweepStaleWorktrees(): Promise<string[]> {
      return [];
    }
  }

  test("routes subsequent tasks through updated rules, args, and env", async () => {
    const root = freshDir();
    const config: WorkspaceConfig = parseWorkspaceConfig(
      V2.replace(/\n\[\[automations\]\][\s\S]*$/, "\n"),
    );
    const repoManager = new StubRepoManager(root);
    const runs: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }> =
      [];
    const executor = createFleetTaskExecutor({
      config,
      workspaceDir: root,
      skips: { record() {} } as unknown as import("../src/lib/workspace/state").RoutingSkipStore,
      repoManager,
      repoLock: () =>
        ({
          acquire: () => ({ success: true, message: "" }),
          release() {},
        }) as never,
      runTask: async (_taskKey, args, opts) => {
        runs.push({ args, cwd: opts.cwd, env: opts.env });
        return true;
      },
    });

    const routable = toRoutableTask({ key: "PROJ-12", components: [], labels: ["backend"] });

    // V2's rule sends the "backend" label to frontend.
    let ok = await executor("PROJ-12", routable);
    expect(ok).toBe(true);
    expect(runs.at(-1)?.cwd).toContain(join("worktrees", "frontend"));
    expect(runs.at(-1)?.args).toEqual(["--create-pr", "--fast"]);

    // Simulate a live reload flipping routing back to backend.
    const next: WorkspaceConfig = parseWorkspaceConfig(`
[defaults]
tracker = "markdown"
task_query = "status=todo"
worker_task_args = "--create-pr --auto-review"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"

[[routing.rules]]
repo = "backend"
labels = ["backend"]
`);
    applyWorkspaceConfig(config, next);

    ok = await executor("PROJ-12", routable);
    expect(ok).toBe(true);
    expect(runs.at(-1)?.cwd).toContain(join("worktrees", "backend"));
    expect(runs.at(-1)?.args).toEqual(["--create-pr", "--auto-review"]);
    // Per-repo env follows the reloaded repo definitions too.
    expect(Object.keys(runs.at(-1)?.env ?? {})).toContain("GITHUB_REPO");
  });
});
