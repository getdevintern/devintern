import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseRunNowArgs, runWorkerRunNow } from "../src/lib/worker/run-now";

// The spawn-level test below starts a real bun CLI process; under full-suite
// load that routinely exceeds bun's 5s default.
setDefaultTimeout(30_000);

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

const WORKSPACE_TOML = `[workspace]

[defaults]
tracker = "jira"
`;

const HELP_TEXT = [
  "Usage: devintern worker run-now [--workspace <path>]",
  "",
  "Ask the running workspace worker to drain ready tasks now,",
  "ignoring working windows (quiet hours) for this one pass.",
  "The worker picks up the request on its next poll interval",
  "(default 60s) and deletes the marker once served.",
].join("\n");

describe("worker run-now argument parsing", () => {
  test("parses the documented flags", () => {
    expect(parseRunNowArgs([])).toEqual({ kind: "ok", workspacePath: undefined });
    expect(parseRunNowArgs(["--workspace", "/tmp/ws/workspace.toml"])).toEqual({
      kind: "ok",
      workspacePath: "/tmp/ws/workspace.toml",
    });
  });

  test("treats -h/--help as help", () => {
    expect(parseRunNowArgs(["--help"]).kind).toBe("help");
    expect(parseRunNowArgs(["-h"]).kind).toBe("help");
  });

  test("rejects a missing, empty, whitespace-only, or flag-like --workspace value", () => {
    const expected = {
      kind: "error",
      message: "--workspace requires a path to workspace.toml.",
    } as const;
    expect(parseRunNowArgs(["--workspace"])).toEqual(expected);
    expect(parseRunNowArgs(["--workspace", ""])).toEqual(expected);
    expect(parseRunNowArgs(["--workspace", "   "])).toEqual(expected);
    expect(parseRunNowArgs(["--workspace", "--help"])).toEqual(expected);
  });

  test("rejects unknown options", () => {
    expect(parseRunNowArgs(["--bogus"])).toEqual({
      kind: "error",
      message: "Unknown option: --bogus",
    });
  });
});

describe("runWorkerRunNow", () => {
  let dir: string;
  let configPath: string;
  let previousWorkspaceDir: string | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `worker-run-now-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "workspace.toml");
    writeFileSync(configPath, WORKSPACE_TOML);
    previousWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = dir;
  });

  afterEach(() => {
    if (previousWorkspaceDir === undefined) {
      delete process.env.DEVINTERN_WORKSPACE_DIR;
    } else {
      process.env.DEVINTERN_WORKSPACE_DIR = previousWorkspaceDir;
    }
    // Restore permissions before removing a read-only fixture.
    chmodSync(dir, 0o700);
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
      },
    };
  }

  test("prints the unchanged help text", () => {
    const cap = capture();
    const code = runWorkerRunNow(["--help"], cap.options);
    expect(code).toBe(0);
    expect(cap.out).toEqual([HELP_TEXT]);
    expect(cap.err).toHaveLength(0);
  });

  test("does not write a marker for a missing --workspace value", () => {
    const cap = capture();
    const code = runWorkerRunNow(["--workspace"], cap.options);
    expect(code).toBe(1);
    expect(cap.err).toEqual(["❌ --workspace requires a path to workspace.toml."]);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });

  test("does not write a marker for an empty or whitespace-only --workspace value", () => {
    for (const value of ["", "   "]) {
      const cap = capture();
      const code = runWorkerRunNow(["--workspace", value], cap.options);
      expect(code).toBe(1);
      expect(cap.err).toEqual(["❌ --workspace requires a path to workspace.toml."]);
      expect(cap.out).toHaveLength(0);
      expect(existsSync(join(dir, ".run-now"))).toBe(false);
    }
  });

  test("resolves the default workspace when no flags are passed", () => {
    const cap = capture();
    const code = runWorkerRunNow([], cap.options);

    expect(code).toBe(0);
    expect(existsSync(join(dir, ".run-now"))).toBe(true);
    expect(cap.err).toHaveLength(0);
    expect(cap.out[0]).toBe(`✅ Run-now requested for ${configPath}`);
    expect(cap.out[1]).toBe(`   Marker: ${join(dir, ".run-now")}`);
  });

  test("does not write a marker for an unknown option", () => {
    const cap = capture();
    const code = runWorkerRunNow(["--bogus"], cap.options);
    expect(code).toBe(1);
    expect(cap.err).toEqual([
      "❌ Unknown option: --bogus",
      "   Run 'devintern worker run-now --help' for usage.",
    ]);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });

  test("requests a drain and warns when no worker is running", () => {
    const cap = capture();
    const code = runWorkerRunNow(["--workspace", configPath], cap.options);

    expect(code).toBe(0);
    expect(existsSync(join(dir, ".run-now"))).toBe(true);
    expect(cap.err).toHaveLength(0);
    expect(cap.out).toEqual([
      `✅ Run-now requested for ${configPath}`,
      `   Marker: ${join(dir, ".run-now")}`,
      "   The worker drains within one poll interval and removes the marker.",
      "⚠️  No worker is running; the marker stays until the next worker's first poll.",
    ]);
  });

  test("keeps the success output unchanged when a worker is running", () => {
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", configPath], cap.options);

    expect(code).toBe(0);
    expect(existsSync(join(dir, ".run-now"))).toBe(true);
    expect(cap.out).toEqual([
      `✅ Run-now requested for ${configPath}`,
      `   Marker: ${join(dir, ".run-now")}`,
      "   The worker drains within one poll interval and removes the marker.",
    ]);
  });

  test("reports an unwritable workspace without a stack trace", () => {
    // Root ignores mode bits, so skip there.
    if (process.getuid?.() === 0) return;
    chmodSync(dir, 0o500);

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", configPath], cap.options);

    expect(code).toBe(1);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
    expect(cap.out).toHaveLength(0);
    expect(cap.err).toHaveLength(4);
    expect(cap.err[0]?.startsWith("❌ Could not request a run-now drain:")).toBe(true);
    expect(cap.err[1]).toBe(`   Marker: ${join(dir, ".run-now")}`);
    expect(cap.err[2]).toBe("   The workspace directory must be writable by this process.");
    expect(cap.err[3]).toBe("   Under a sandbox, add it to AGENT_SANDBOX_WRITABLE_PATHS.");
  });

  test("accepts a config file with a non-standard filename", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    const customPath = join(sub, "custom.toml");
    writeFileSync(customPath, WORKSPACE_TOML);

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", customPath], cap.options);

    expect(code).toBe(0);
    expect(existsSync(join(sub, ".run-now"))).toBe(true);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
    expect(cap.err).toHaveLength(0);
    expect(cap.out[0]).toBe(`✅ Run-now requested for ${customPath}`);
    expect(cap.out[1]).toBe(`   Marker: ${join(sub, ".run-now")}`);
  });

  test("rejects a directory value instead of writing the parent's marker", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "workspace.toml"), WORKSPACE_TOML);

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", sub], cap.options);

    expect(code).toBe(1);
    expect(cap.err).toEqual([
      `❌ ${sub} is a directory; pass the path to a workspace config file.`,
    ]);
    expect(cap.out).toHaveLength(0);
    expect(existsSync(join(sub, ".run-now"))).toBe(false);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });

  test("rejects an existing non-config file instead of writing into its directory", () => {
    const other = join(dir, "checkout");
    mkdirSync(other, { recursive: true });
    const packagePath = join(other, "package.json");
    writeFileSync(packagePath, JSON.stringify({ name: "app", version: "1.0.0" }));

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", packagePath], cap.options);

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(0);
    expect(cap.err[0]?.startsWith(`❌ Could not read ${packagePath}:`)).toBe(true);
    expect(existsSync(join(other, ".run-now"))).toBe(false);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });

  test("rejects valid TOML that is not a workspace config", () => {
    const other = join(dir, "toml");
    mkdirSync(other, { recursive: true });
    const unrelatedPath = join(other, "unrelated.toml");
    writeFileSync(unrelatedPath, `[package]\nname = "app"\n`);

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", unrelatedPath], cap.options);

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(0);
    expect(cap.err[0]?.startsWith(`❌ Could not read ${unrelatedPath}:`)).toBe(true);
    expect(existsSync(join(other, ".run-now"))).toBe(false);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });

  test("requests a drain despite a transiently invalid config when a worker is running", () => {
    // The running worker reloads workspace.toml itself and keeps its last good
    // config on failure, so a bad edit must not block the forced drain.
    writeFileSync(
      join(dir, ".worker.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    writeFileSync(configPath, "[broken");

    const cap = capture();
    const code = runWorkerRunNow(["--workspace", configPath], cap.options);

    expect(code).toBe(0);
    expect(existsSync(join(dir, ".run-now"))).toBe(true);
    expect(cap.err).toHaveLength(0);
    expect(cap.out[0]?.startsWith(`⚠️  Could not read ${configPath}:`)).toBe(true);
    expect(cap.out[1]).toBe(
      "   A worker is running with its last good config; requesting the drain anyway.",
    );
    expect(cap.out[2]).toBe(`✅ Run-now requested for ${configPath}`);
    expect(cap.out[3]).toBe(`   Marker: ${join(dir, ".run-now")}`);
  });

  test("rejects a transiently invalid default config when no worker is running", () => {
    writeFileSync(configPath, "[broken");

    const cap = capture();
    const code = runWorkerRunNow([], cap.options);

    expect(code).toBe(1);
    expect(cap.out).toHaveLength(0);
    expect(cap.err[0]?.startsWith(`❌ Could not read ${configPath}:`)).toBe(true);
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });

  test("fails clearly when the workspace has no workspace.toml", () => {
    const cap = capture();
    const code = runWorkerRunNow(
      ["--workspace", join(dir, "missing", "workspace.toml")],
      cap.options,
    );

    expect(code).toBe(1);
    expect(cap.err).toEqual([`❌ No workspace.toml at ${join(dir, "missing", "workspace.toml")}.`]);
  });

  test("CLI wrapper propagates the run-now exit code", () => {
    const env = {
      ...process.env,
      DEVINTERN_WORKSPACE_DIR: dir,
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      SENTRY_DISABLED: "1",
    };

    const help = spawnSync("bun", [CLI_PATH, "worker", "run-now", "--help"], {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: devintern worker run-now");
    expect(existsSync(join(dir, ".run-now"))).toBe(false);

    const bogus = spawnSync("bun", [CLI_PATH, "worker", "run-now", "--bogus"], {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    expect(bogus.status).toBe(1);
    expect(bogus.stderr).toContain("Unknown option: --bogus");
    expect(existsSync(join(dir, ".run-now"))).toBe(false);
  });
});
