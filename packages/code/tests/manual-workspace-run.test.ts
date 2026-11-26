import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { WORKER_SUBPROCESS_ENV, setManualWorkspaceStateDir } from "../src/lib/config/config-dir";
import {
  acquireTicketLocks,
  checkoutLockFileName,
  ticketLockFileName,
} from "../src/lib/task/ticket-lock";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import {
  applyManualWorkspaceRun,
  findRepoForOrigin,
  findWorkspaceRepoForCheckout,
} from "../src/lib/workspace/manual-run";

const WORKSPACE_TOML = `
[[repos]]
name = "web"
remote = "git@github.com:Acme/Web.git"
manual_only = true
  [repos.env]
  TASK_TRACKER = "linear"

[[repos]]
name = "api"
remote = "https://gitlab.com/acme/api.git"
manual_only = true
`;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

describe("findRepoForOrigin", () => {
  const config = parseWorkspaceConfig(WORKSPACE_TOML);

  test("matches across URL forms, case-insensitively for GitHub", () => {
    expect(findRepoForOrigin(config, "https://github.com/acme/web\n", "/nowhere")?.name).toBe(
      "web",
    );
    expect(findRepoForOrigin(config, "git@gitlab.com:acme/api.git", "/nowhere")?.name).toBe("api");
  });

  test("does not match another project or host", () => {
    expect(findRepoForOrigin(config, "git@github.com:acme/other.git", "/nowhere")).toBeNull();
    expect(findRepoForOrigin(config, "git@gitlab.com:acme/web.git", "/nowhere")).toBeNull();
    expect(findRepoForOrigin(config, "not a url", "/nowhere")).toBeNull();
  });
});

describe("manual runs in a workspace checkout", () => {
  let root: string;
  let workspace: string;
  let checkout: string;
  const saved = { ...process.env };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "manual-workspace-run-"));
    workspace = join(root, "workspace");
    checkout = join(root, "checkout");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(workspace, "workspace.toml"), WORKSPACE_TOML);
    writeFileSync(join(workspace, ".env"), "JIRA_BASE_URL=https://example.atlassian.net\n");
    git(checkout, ["init", "-q"]);
    git(checkout, ["remote", "add", "origin", "git@github.com:acme/web.git"]);
    delete process.env[WORKER_SUBPROCESS_ENV];
  });

  afterEach(() => {
    // `applyManualWorkspaceRun` pins the runtime state dir process-wide.
    setManualWorkspaceStateDir(null);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });

  test("resolves the registered repo from origin", async () => {
    const run = await findWorkspaceRepoForCheckout({ cwd: checkout, workspaceDir: workspace });
    expect(run?.repo.name).toBe("web");
  });

  test("returns null in worker subprocesses, without a workspace, or for an unknown origin", async () => {
    process.env[WORKER_SUBPROCESS_ENV] = "1";
    expect(
      await findWorkspaceRepoForCheckout({ cwd: checkout, workspaceDir: workspace }),
    ).toBeNull();
    delete process.env[WORKER_SUBPROCESS_ENV];
    expect(
      await findWorkspaceRepoForCheckout({ cwd: checkout, workspaceDir: join(root, "none") }),
    ).toBeNull();
    git(checkout, ["remote", "set-url", "origin", "git@github.com:acme/elsewhere.git"]);
    expect(
      await findWorkspaceRepoForCheckout({ cwd: checkout, workspaceDir: workspace }),
    ).toBeNull();
  });

  test("applies workspace env and state without the worker marker", async () => {
    const run = await findWorkspaceRepoForCheckout({ cwd: checkout, workspaceDir: workspace });
    if (!run) throw new Error("expected a workspace repo");
    delete process.env.WEBHOOK_QUEUE_DB;
    applyManualWorkspaceRun(run);
    // `String()`: TypeScript still narrows the env var to the deleted state.
    expect(String(process.env.WEBHOOK_QUEUE_DB)).toBe(join(workspace, "state", "queue.db"));
    expect(process.env.DEVINTERN_WORKSPACE_DIR).toBe(workspace);
    expect(process.env.DEVINTERN_WORKSPACE_REPO).toBe("web");
    expect(process.env.TASK_TRACKER).toBe("linear");
    expect(process.env.JIRA_BASE_URL).toBe("https://example.atlassian.net");
    expect(process.env.GITHUB_REPO).toBe("Acme/Web");
    expect(process.env[WORKER_SUBPROCESS_ENV]).toBeUndefined();
  });

  test("keeps an explicit WEBHOOK_QUEUE_DB and applies only runtime keys with --env-file", async () => {
    const run = await findWorkspaceRepoForCheckout({ cwd: checkout, workspaceDir: workspace });
    if (!run) throw new Error("expected a workspace repo");
    process.env.WEBHOOK_QUEUE_DB = join(root, "pinned.db");
    delete process.env.TASK_TRACKER;
    delete process.env.JIRA_BASE_URL;
    applyManualWorkspaceRun(run, { runtimeOnly: true });
    expect(process.env.WEBHOOK_QUEUE_DB).toBe(join(root, "pinned.db"));
    expect(process.env.DEVINTERN_WORKSPACE_REPO).toBe("web");
    // Credentials and tracker settings stay with the explicit env file.
    expect(process.env.TASK_TRACKER).toBeUndefined();
    expect(process.env.JIRA_BASE_URL).toBeUndefined();
  });
});

describe("ticket locks", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ticket-locks-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("names tracker keys by key and file tasks by hash", () => {
    expect(ticketLockFileName("dev-12")).toBe("DEV-12.lock");
    expect(ticketLockFileName("acme/web#3")).toMatch(/^task-[0-9a-f]{16}\.lock$/);
    expect(ticketLockFileName("./a/task.md", true)).not.toBe(
      ticketLockFileName("./b/task.md", true),
    );
    expect(checkoutLockFileName(workspace)).toMatch(/^[0-9a-f]{16}\.lock$/);
  });

  test("a held ticket blocks another run and is free after release", () => {
    const first = acquireTicketLocks([{ key: "DEV-1" }, { key: "DEV-2" }], workspace);
    if (!first.ok) throw new Error(first.message);
    const writeHolder = spawnSync(
      "bun",
      [
        "-e",
        `import { acquireTicketLocks } from ${JSON.stringify(join(import.meta.dir, "../src/lib/task/ticket-lock.ts"))};
         const r = acquireTicketLocks([{ key: "dev-2" }], ${JSON.stringify(workspace)});
         console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, message: r.message }));`,
      ],
      { encoding: "utf8" },
    );
    const other = JSON.parse(writeHolder.stdout.trim()) as { ok: boolean; message?: string };
    expect(other.ok).toBe(false);
    expect(other.message).toContain("dev-2 is already being processed");

    first.locks.release();
    const again = acquireTicketLocks([{ key: "DEV-2" }], workspace);
    expect(again.ok).toBe(true);
    if (again.ok) again.locks.release();
  });
});
