/**
 * Regression coverage for DEV-126: worker task runs must resolve durable
 * state to the workspace home, and a repo checkout must never have
 * `.devintern-code/` runtime artifacts staged into a PR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  resolveRuntimeStateDir,
  setManualWorkspaceStateDir,
  WORKER_SUBPROCESS_ENV,
} from "../src/lib/config/config-dir";
import { loadSupabaseConfig } from "../src/lib/cli/bootstrap";
import { buildRepoEnv, buildWorkspaceContextEnv } from "../src/lib/workspace/env";
import { ensureWorkspaceCodeState } from "../src/lib/workspace/paths";

describe("fleet config-dir isolation (DEV-126)", () => {
  let root: string;
  const priorWorkspace = process.env.DEVINTERN_WORKSPACE_DIR;
  const priorMarker = process.env[WORKER_SUBPROCESS_ENV];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-isolation-"));
  });

  afterEach(() => {
    setManualWorkspaceStateDir(null);
    if (priorWorkspace === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = priorWorkspace;
    if (priorMarker === undefined) delete process.env[WORKER_SUBPROCESS_ENV];
    else process.env[WORKER_SUBPROCESS_ENV] = priorMarker;
    rmSync(root, { recursive: true, force: true });
  });

  test("buildRepoEnv passes workspace context to task subprocesses", () => {
    const workspaceDir = join(root, "workspace");
    const env = buildRepoEnv(
      { name: "backend", remote: "git@example.com:x/y.git", env: {} },
      workspaceDir,
    );
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe(workspaceDir);
    expect(env[WORKER_SUBPROCESS_ENV]).toBe("1");
  });

  test("workspace-context runs pin the workspace so auth resolves there", () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "workspace.toml"), "");

    // A daemon started with a non-default `--workspace` has no ambient
    // DEVINTERN_WORKSPACE_DIR; only the composed child env carries it.
    delete process.env.DEVINTERN_WORKSPACE_DIR;
    delete process.env[WORKER_SUBPROCESS_ENV];
    const env = buildWorkspaceContextEnv(workspace);
    expect(env.DEVINTERN_WORKSPACE_DIR).toBe(workspace);
    expect(env[WORKER_SUBPROCESS_ENV]).toBe("1");

    process.env.DEVINTERN_WORKSPACE_DIR = workspace;
    process.env[WORKER_SUBPROCESS_ENV] = "1";
    expect(loadSupabaseConfig().sessionFilePath).toBe(
      join(workspace, "state", "code", ".auth-session.json"),
    );
  });

  test("every run uses the workspace runtime state, never a checkout", () => {
    const workspace = join(root, "workspace");
    process.env.DEVINTERN_WORKSPACE_DIR = workspace;

    delete process.env[WORKER_SUBPROCESS_ENV];
    expect(resolveRuntimeStateDir()).toBe(join(workspace, "state", "code"));
    process.env[WORKER_SUBPROCESS_ENV] = "1";
    expect(resolveRuntimeStateDir()).toBe(join(workspace, "state", "code"));
  });

  test("manual commands for registered repos use the workspace session", () => {
    const checkout = join(root, "checkout");
    const workspace = join(root, "workspace");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    delete process.env[WORKER_SUBPROCESS_ENV];

    process.env.DEVINTERN_WORKSPACE_DIR = join(root, "default-workspace");
    setManualWorkspaceStateDir(workspace);
    expect(resolveRuntimeStateDir()).toBe(join(workspace, "state", "code"));

    setManualWorkspaceStateDir(null);
    expect(resolveRuntimeStateDir()).toBe(join(root, "default-workspace", "state", "code"));
  });

  test("worker subprocesses do not load a checkout's local credentials", () => {
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(checkout, ".devintern-code", ".env"),
      "DEVINTERN_LOCAL_CREDENTIAL_TEST=from-local-checkout\n",
    );
    const bootstrapPath = join(__dirname, "..", "src", "lib", "cli", "bootstrap.ts");
    const script = `import { loadEnvironment } from ${JSON.stringify(bootstrapPath)}; console.log(JSON.stringify({ path: loadEnvironment(), credential: process.env.DEVINTERN_LOCAL_CREDENTIAL_TEST ?? null }));`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [WORKER_SUBPROCESS_ENV]: "1",
      SENTRY_DISABLED: "1",
    };
    delete env.DEVINTERN_LOCAL_CREDENTIAL_TEST;

    const result = spawnSync("bun", ["-e", script], { cwd: checkout, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{"path":null,"credential":null}');

    delete env[WORKER_SUBPROCESS_ENV];
    const manualScript = `import { loadEnvironment } from ${JSON.stringify(bootstrapPath)}; console.log(JSON.stringify({ path: loadEnvironment(undefined, { skipProjectEnv: true }), credential: process.env.DEVINTERN_LOCAL_CREDENTIAL_TEST ?? null }));`;
    const manual = spawnSync("bun", ["-e", manualScript], {
      cwd: checkout,
      env,
      encoding: "utf8",
    });
    expect(manual.status).toBe(0);
    expect(manual.stdout.trim()).toBe('{"path":null,"credential":null}');
  });
});

describe("worker daemon auth/license state (DEV-126)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-daemon-config-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("daemon license gate sees the workspace session from a non-workspace cwd", () => {
    const checkoutConfigDir = join(root, "checkout", ".devintern-code");
    const workspaceDir = join(root, "workspace");
    const workspaceConfigDirPath = join(workspaceDir, "state", "code");
    mkdirSync(checkoutConfigDir, { recursive: true });
    mkdirSync(workspaceConfigDirPath, { recursive: true });
    const sessionFile = join(workspaceConfigDirPath, ".auth-session.json");
    writeFileSync(sessionFile, JSON.stringify({ accessToken: "a", refreshToken: "r" }));

    expect(loadSupabaseConfig(checkoutConfigDir).sessionFilePath).toBe(
      join(checkoutConfigDir, ".auth-session.json"),
    );
    expect(loadSupabaseConfig(workspaceConfigDirPath).sessionFilePath).toBe(sessionFile);
    expect(existsSync(sessionFile)).toBe(true);
  });

  test("moves existing workspace auth and relay state without replacing new files", () => {
    const workspace = join(root, "workspace");
    const legacy = join(workspace, ".devintern-code");
    const current = join(workspace, "state", "code");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(join(legacy, ".auth-session.json"), "old-session");
    writeFileSync(join(legacy, "relay.json"), "old-relay");
    writeFileSync(join(current, ".auth-session.json"), "new-session");
    ensureWorkspaceCodeState(workspace);
    expect(readFileSync(join(current, ".auth-session.json"), "utf8")).toBe("new-session");
    expect(readFileSync(join(current, "relay.json"), "utf8")).toBe("old-relay");
    // Moved and superseded files are gone, so the legacy layer disappears.
    expect(existsSync(legacy)).toBe(false);
  });

  test("moves GitHub App pairing and license cache, dropping an empty stray queue.db", () => {
    const workspace = join(root, "workspace");
    const legacy = join(workspace, ".devintern-code");
    const current = join(workspace, "state", "code");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "github-app.json"), '{"repositories":[]}\n');
    writeFileSync(join(legacy, "license-cache.json"), "{}");
    writeFileSync(join(legacy, "queue.db"), "");
    ensureWorkspaceCodeState(workspace);
    expect(readFileSync(join(current, "github-app.json"), "utf8")).toBe('{"repositories":[]}\n');
    expect(readFileSync(join(current, "license-cache.json"), "utf8")).toBe("{}");
    expect(existsSync(legacy)).toBe(false);
  });

  test("keeps the legacy directory when it holds data it does not own", () => {
    const workspace = join(root, "workspace");
    const legacy = join(workspace, ".devintern-code");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "relay.json"), "old-relay");
    writeFileSync(join(legacy, "queue.db"), "not empty");
    writeFileSync(join(legacy, "notes.txt"), "mine");
    ensureWorkspaceCodeState(workspace);
    expect(existsSync(join(legacy, "relay.json"))).toBe(false);
    expect(readFileSync(join(legacy, "queue.db"), "utf8")).toBe("not empty");
    expect(readFileSync(join(legacy, "notes.txt"), "utf8")).toBe("mine");
  });
});
