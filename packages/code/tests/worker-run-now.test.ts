import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseRunNowArgs, runWorkerRunNow } from "../src/lib/worker/run-now";

const WORKSPACE_TOML = `[workspace]
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

  test("rejects a missing or flag-like --workspace value", () => {
    expect(parseRunNowArgs(["--workspace"])).toEqual({
      kind: "error",
      message: "--workspace requires a path to workspace.toml.",
    });
    expect(parseRunNowArgs(["--workspace", "--help"])).toEqual({
      kind: "error",
      message: "--workspace requires a path to workspace.toml.",
    });
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

  test("fails clearly when the workspace has no workspace.toml", () => {
    const cap = capture();
    const code = runWorkerRunNow(
      ["--workspace", join(dir, "missing", "workspace.toml")],
      cap.options,
    );

    expect(code).toBe(1);
    expect(cap.err).toEqual([`❌ No workspace.toml at ${join(dir, "missing", "workspace.toml")}.`]);
  });
});
