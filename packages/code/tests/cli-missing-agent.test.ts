import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Fresh bun subprocesses routinely exceed bun's 5s default under suite load.
setDefaultTimeout(30_000);

const CLI_PATH = join(__dirname, "..", "src", "index.ts");
const CLI_SPAWN_TIMEOUT_MS = 30_000;

let rootDir: string;
let binDir: string;
let homeDir: string;
let workDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "cli-missing-agent-"));
  binDir = join(rootDir, "bin");
  homeDir = join(rootDir, "home");
  workDir = join(rootDir, "work");
  for (const dir of [binDir, homeDir, workDir]) mkdirSync(dir, { recursive: true });
  // PATH holds only bun, so no agent CLI (claude, codex, ...) can be found.
  symlinkSync(process.execPath, join(binDir, "bun"));
  writeFileSync(join(workDir, "TASK-1.md"), "# Task one\n\nDo the thing.\n");
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** Run the CLI with a minimal env built from scratch so no agent override leaks in. */
function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    PATH: binDir,
    HOME: homeDir,
    DEVINTERN_WORKSPACE_DIR: process.env.DEVINTERN_WORKSPACE_DIR ?? join(rootDir, "workspace"),
    GIT_CEILING_DIRECTORIES: rootDir,
    DEVINTERN_NO_UPDATE: "1",
    DEVINTERN_SKIP_LICENSE_CHECK: "1",
    SENTRY_DISABLED: "1",
  };
  return spawnSync(join(binDir, "bun"), [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: CLI_SPAWN_TIMEOUT_MS,
    cwd: workDir,
    env,
  });
}

describe("CLI with no agent CLI on PATH", () => {
  test.each([["TASK-1"], ["./TASK-1.md"]])(
    "manual run of %s prints a clean error and exits 1",
    (task) => {
      const result = runCli([task, "--no-update"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        '❌ Claude Code CLI not found: "claude" is not on your PATH.',
      );
      expect(result.stderr).toContain("Run `devintern doctor` to check your setup.");
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("at resolveExecutablePathStrict");
      expect(output).not.toMatch(/^\s*at /m);
      expect(output).not.toMatch(/^\s*\d+ \|/m);
      expect(output).not.toContain("Bun v");
    },
  );

  test("an explicit --agent-path command that is not on PATH gets the same clean error", () => {
    const result = runCli(["TASK-1", "--no-update", "--agent-path", "not-a-real-agent-cli"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('❌ Claude Code CLI not found: "not-a-real-agent-cli"');
    expect(result.stderr).toContain("Run `devintern doctor` to check your setup.");
    expect(result.stdout + result.stderr).not.toMatch(/^\s*at /m);
  });

  test.each([["--help"], ["--version"]])("%s still works", (flag) => {
    const result = runCli([flag]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("❌");
  });
});
