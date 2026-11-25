import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// `devintern doctor` / `devintern sandbox` in a checkout registered by
// `devintern init` must read the repo's workspace env file, like a task run.

// Fresh bun subprocesses routinely exceed bun's 5s default under suite load.
setDefaultTimeout(30_000);

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

let rootDir: string;
let binDir: string;
let homeDir: string;
let workspaceDir: string;
let checkoutDir: string;
let repoEnvPath: string;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** Register the checkout the way `devintern init` does. */
function registerCheckout(repoEnv: string): void {
  writeFileSync(
    join(workspaceDir, "workspace.toml"),
    [
      "[[repos]]",
      'name = "demo"',
      'remote = "https://github.com/example-org/demo.git"',
      "manual_only = true",
      'env_file = "env/demo.env"',
      "",
    ].join("\n"),
  );
  mkdirSync(join(workspaceDir, "env"), { recursive: true });
  writeFileSync(repoEnvPath, repoEnv);
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "checkout-env-commands-"));
  binDir = join(rootDir, "bin");
  homeDir = join(rootDir, "home");
  workspaceDir = join(rootDir, "workspace");
  checkoutDir = join(rootDir, "demo");
  repoEnvPath = join(workspaceDir, "env", "demo.env");
  for (const dir of [binDir, homeDir, workspaceDir, checkoutDir])
    mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(binDir, "bun"));
  const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(gitPath, join(binDir, "git"));
  git(checkoutDir, ["init", "-q"]);
  git(checkoutDir, ["remote", "add", "origin", "https://github.com/example-org/demo.git"]);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** Run the CLI in the checkout with a minimal env so nothing leaks in from the shell. */
function runCli(args: string[]) {
  const result = spawnSync(join(binDir, "bun"), [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: checkoutDir,
    env: {
      PATH: binDir,
      HOME: homeDir,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      GIT_CEILING_DIRECTORIES: rootDir,
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      DEVINTERN_TELEMETRY_DISABLED: "1",
      SENTRY_DISABLED: "1",
    },
  });
  return result.stdout + result.stderr;
}

describe("devintern doctor in a registered checkout", () => {
  test("reports the Markdown tracker from the repo env file", () => {
    registerCheckout("TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=tasks\n");

    const output = runCli(["doctor"]);

    expect(output).toContain(`✅ Task tracker — markdown (${repoEnvPath})`);
    expect(output).not.toContain("JIRA");
  });

  test("reports a credential-based tracker whose credentials live only in the repo env file", () => {
    registerCheckout("TASK_TRACKER=linear\nLINEAR_API_KEY=lin_test_key\n");

    const output = runCli(["doctor"]);

    expect(output).toContain(`✅ Task tracker — Linear (${repoEnvPath})`);
    expect(output).not.toContain("missing LINEAR_API_KEY");
    expect(output).not.toContain("JIRA");
  });

  test("ignores the checkout's own project .env", () => {
    registerCheckout("TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=tasks\n");
    writeFileSync(join(checkoutDir, ".env"), "TASK_TRACKER=jira\n");

    const output = runCli(["doctor"]);

    expect(output).toContain(`✅ Task tracker — markdown (${repoEnvPath})`);
  });
});

describe("devintern sandbox in a registered checkout", () => {
  test("shows AGENT_SANDBOX from the repo env file, attributed to it", () => {
    registerCheckout("TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=tasks\nAGENT_SANDBOX=auto\n");

    const output = runCli(["sandbox"]);

    expect(output).toContain(`Configured: AGENT_SANDBOX=auto (${repoEnvPath})`);
  });
});

describe("unregistered checkout", () => {
  test("doctor and sandbox still read the project .env", () => {
    const projectEnv = join(checkoutDir, ".env");
    writeFileSync(
      projectEnv,
      "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=tasks\nAGENT_SANDBOX=auto\n",
    );

    expect(runCli(["doctor"])).toContain(`✅ Task tracker — markdown (${projectEnv})`);
    expect(runCli(["sandbox"])).toContain(`Configured: AGENT_SANDBOX=auto (${projectEnv})`);
  });
});
