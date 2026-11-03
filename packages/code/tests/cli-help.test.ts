import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Subcommand help must never execute the command: `init --help` used to
// scaffold `.devintern-code/`, and `logout --help` signed the user out.
setDefaultTimeout(30_000);

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

interface HelpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHelp(args: string[]): Promise<HelpResult & { dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cli-help-"));
  const proc = Bun.spawn({
    cmd: ["bun", CLI_PATH, ...args],
    cwd: dir,
    env: {
      ...process.env,
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      SENTRY_DISABLED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.then((code) => code ?? 0),
  ]);
  return { stdout, stderr, exitCode, dir };
}

async function expectHelp(
  args: string[],
  usage: string,
  inspect?: (result: HelpResult & { dir: string }) => void,
): Promise<HelpResult> {
  const result = await runHelp(args);
  try {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(usage);
    expect(result.stderr).not.toContain("❌");
    inspect?.(result);
  } finally {
    rmSync(result.dir, { recursive: true, force: true });
  }
  return result;
}

describe.concurrent("subcommand --help", () => {
  test("init --help prints usage without scaffolding the project", async () => {
    await expectHelp(["init", "--help"], "Usage: devintern init", (result) => {
      expect(existsSync(join(result.dir, ".devintern-code"))).toBe(false);
    });
  });

  test("logout --help prints usage without signing out", async () => {
    const result = await expectHelp(["logout", "--help"], "Usage: devintern logout");
    expect(result.stdout).not.toContain("Signed out");
  });

  test("login --help prints usage without prompting for a method", async () => {
    await expectHelp(["login", "--help"], "Usage: devintern login");
  });

  test("whoami --help prints usage instead of the session state", async () => {
    const result = await expectHelp(["whoami", "--help"], "Usage: devintern whoami");
    expect(result.stdout).not.toContain("Not signed in");
  });

  test("sandbox --help prints usage without running the doctor", async () => {
    const result = await expectHelp(["sandbox", "--help"], "Usage: devintern sandbox");
    expect(result.stdout).not.toContain("Providers on this machine");
  });

  test("doctor --help prints usage without running readiness checks", async () => {
    const result = await expectHelp(["doctor", "--help"], "Usage: devintern doctor");
    expect(result.stdout).not.toContain("devintern readiness");
  });

  test("workspace --help points at worker instead of exiting as an error", async () => {
    await expectHelp(["workspace", "--help"], "devintern worker --help");
  });
});
