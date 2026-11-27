import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { WORKER_SUBPROCESS_ENV } from "../src/lib/config/config-dir";
import { runWorkerRepoDoctor } from "../src/lib/observability/cli";
import type { WorkerDoctorTextResult } from "../src/lib/observability/worker-doctor-text";

const WORKSPACE_TOML = `
[defaults]
tracker = "github"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
manual_only = true
`;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function result(overrides: Partial<WorkerDoctorTextResult> = {}): WorkerDoctorTextResult {
  return {
    checks: [],
    hasFailures: false,
    hasWarnings: false,
    hasActions: false,
    exitCode: 0,
    ...overrides,
  };
}

describe("devintern doctor routing", () => {
  let root: string;
  let workspace: string;
  let checkout: string;
  let logs: string[];
  const saved = { ...process.env };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "doctor-routing-"));
    workspace = join(root, "workspace");
    checkout = join(root, "checkout");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(workspace, "workspace.toml"), WORKSPACE_TOML);
    git(checkout, ["init", "-q"]);
    logs = [];
    delete process.env[WORKER_SUBPROCESS_ENV];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });

  function run(
    origin: string | null,
    checks: WorkerDoctorTextResult,
    strict = false,
  ): Promise<{ code: number | null; calls: string[] }> {
    if (origin) git(checkout, ["remote", "add", "origin", origin]);
    const calls: string[] = [];
    return runWorkerRepoDoctor(strict, {
      cwd: checkout,
      workspaceDir: workspace,
      log: (message) => logs.push(message),
      runChecks: (workspaceDir, options) => {
        calls.push(`${workspaceDir}|${options.workspacePath}`);
        return Promise.resolve(checks);
      },
    }).then((code) => ({ code, calls }));
  }

  test("a worker repository runs the worker checks", async () => {
    const { code, calls } = await run("https://github.com/acme/web.git", result());

    expect(code).toBe(0);
    expect(calls).toEqual([`${workspace}|${join(workspace, "workspace.toml")}`]);
    expect(logs.join("\n")).toContain('worker repository "web"');
    expect(logs.join("\n")).toContain("`devintern worker doctor`");
  });

  test("worker exit codes carry over; --strict also fails on warnings", async () => {
    expect((await run("git@github.com:acme/web.git", result({ exitCode: 1 }))).code).toBe(1);
    git(checkout, ["remote", "remove", "origin"]);
    expect((await run("git@github.com:acme/web.git", result({ exitCode: 2 }))).code).toBe(2);
    git(checkout, ["remote", "remove", "origin"]);
    const warned = result({ hasWarnings: true });
    expect((await run("git@github.com:acme/web.git", warned)).code).toBe(0);
    git(checkout, ["remote", "remove", "origin"]);
    expect((await run("git@github.com:acme/web.git", warned, true)).code).toBe(2);
  });

  test("manual-only and unregistered checkouts keep the per-repo doctor", async () => {
    const manual = await run("git@github.com:acme/api.git", result());
    expect(manual.code).toBeNull();
    expect(manual.calls).toEqual([]);
    git(checkout, ["remote", "set-url", "origin", "git@github.com:acme/other.git"]);
    const unknown = await run(null, result());
    expect(unknown.code).toBeNull();
    expect(unknown.calls).toEqual([]);
    expect(logs).toEqual([]);
  });
});
