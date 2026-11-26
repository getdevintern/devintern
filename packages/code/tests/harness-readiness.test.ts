import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ReadinessCheck } from "../src/lib/observability/readiness";
import { defaultCheckHarness, harnessEnvScopes } from "../src/lib/observability/harness-readiness";
import { collectWorkerDoctorChecks } from "../src/lib/observability/worker-readiness";
import type { WorkerDoctorDeps } from "../src/lib/observability/worker-readiness";

const ok = (id: string): ReadinessCheck => ({ id, label: id, status: "ok" });

const ONE_REPO = `
[defaults]
tracker = "jira"
task_query = "project = APP"

[[repos]]
name = "app"
remote = "git@github.com:acme/app.git"
env_file = "env/app.env"
`;

const JIRA_ENV = [
  "JIRA_BASE_URL=https://acme.atlassian.net",
  "JIRA_EMAIL=bot@acme.com",
  "JIRA_API_TOKEN=secret",
  "AGENT_HARNESS=claude-code",
].join("\n");

let workspaceDir: string;
let binDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "harness-readiness-"));
  binDir = mkdtempSync(join(tmpdir(), "harness-readiness-bin-"));
  mkdirSync(join(workspaceDir, "env"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

/** A stub agent executable at `binDir/<name>`. */
function fakeCli(name: string, mode = 0o755): string {
  const path = join(binDir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
  return path;
}

function writeWorkspace(options: { env?: string; repoEnv?: string } = {}): string {
  const configPath = join(workspaceDir, "workspace.toml");
  writeFileSync(configPath, ONE_REPO);
  writeFileSync(join(workspaceDir, ".env"), [JIRA_ENV, options.env ?? ""].join("\n"));
  if (options.repoEnv !== undefined) {
    writeFileSync(join(workspaceDir, "env", "app.env"), options.repoEnv);
  }
  return configPath;
}

/**
 * Doctor deps with every probe but the harness stubbed. The process env has
 * no CLI path and a PATH without any agent CLI, like the init process that
 * has not loaded the workspace `.env`.
 */
function doctorDeps(processEnv: Record<string, string | undefined>): WorkerDoctorDeps {
  return {
    processEnv,
    probeCredentials: async () => {},
    dryRunQuery: async () => 1,
    checkRepoAccess: async () => ({ ok: true }),
    checkEntitlement: async () => ({ valid: true, source: "entitlement", message: "" }),
    checkSandbox: async () => ok("sandbox"),
    checkGitIdentity: async () => ok("git-identity"),
    isPortInUse: async () => false,
    workerStatus: () => ({ status: "stopped" }),
  };
}

async function harnessRow(
  workspacePath: string,
  processEnv: Record<string, string | undefined> = { PATH: "/usr/bin:/bin" },
): Promise<ReadinessCheck | undefined> {
  const checks = await collectWorkerDoctorChecks({ workspacePath }, doctorDeps(processEnv));
  return checks.find((check) => check.id === "harness");
}

describe("worker doctor harness detection", () => {
  test("a CLI path set only in the workspace .env is installed", async () => {
    const cli = fakeCli("claude-custom");
    const workspacePath = writeWorkspace({ env: `CLAUDE_CODE_CLI_PATH=${cli}` });
    const row = await harnessRow(workspacePath);
    expect(row?.status).toBe("ok");
    expect(row?.detail).toBe("claude-code");
  });

  test("a CLI path set only in the repo env file is installed", async () => {
    const cli = fakeCli("claude-custom");
    const workspacePath = writeWorkspace({ repoEnv: `CLAUDE_CODE_CLI_PATH=${cli}\n` });
    const row = await harnessRow(workspacePath);
    expect(row?.status).toBe("ok");
    expect(row?.detail).toBe("claude-code");
  });

  test("a missing path in the workspace .env names the key, path, and file", async () => {
    const bogus = join(binDir, "no-such-claude");
    const workspacePath = writeWorkspace({ env: `CLAUDE_CODE_CLI_PATH=${bogus}` });
    const row = await harnessRow(workspacePath);
    expect(row?.status).toBe("fail");
    expect(row?.detail).toBe(
      `claude-code: CLAUDE_CODE_CLI_PATH=${bogus} (set in ${join(workspaceDir, ".env")}) does not exist`,
    );
    expect(row?.hint).toContain(join(workspaceDir, ".env"));
  });

  test("a non-executable path in the repo env file is reported against that file", async () => {
    const cli = fakeCli("claude-not-exec", 0o644);
    const repoEnvPath = join(workspaceDir, "env", "app.env");
    const workspacePath = writeWorkspace({ repoEnv: `CLAUDE_CODE_CLI_PATH=${cli}\n` });
    const row = await harnessRow(workspacePath);
    expect(row?.status).toBe("fail");
    expect(row?.detail).toBe(
      `claude-code: CLAUDE_CODE_CLI_PATH=${cli} (set in ${repoEnvPath}) is not executable`,
    );
  });

  test("the repo env file overrides a bad workspace path, like the task subprocess", async () => {
    const cli = fakeCli("claude-custom");
    const workspacePath = writeWorkspace({
      env: `CLAUDE_CODE_CLI_PATH=${join(binDir, "missing")}`,
      repoEnv: `CLAUDE_CODE_CLI_PATH=${cli}\n`,
    });
    const row = await harnessRow(workspacePath);
    expect(row?.status).toBe("ok");
  });

  test("a CLI path left in this process but not in the spawn env does not count", async () => {
    const cli = fakeCli("claude-custom");
    const previous = process.env.CLAUDE_CODE_CLI_PATH;
    process.env.CLAUDE_CODE_CLI_PATH = cli;
    try {
      const workspacePath = writeWorkspace();
      const row = await harnessRow(workspacePath, { PATH: binDir });
      expect(row?.status).toBe("fail");
      expect(process.env.CLAUDE_CODE_CLI_PATH).toBe(cli);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
      else process.env.CLAUDE_CODE_CLI_PATH = previous;
    }
  });
});

describe("defaultCheckHarness PATH detection", () => {
  test("finds the default CLI on PATH without any path override", async () => {
    fakeCli("claude");
    const env = { AGENT_HARNESS: "claude-code", PATH: `${binDir}:/usr/bin:/bin` };
    const row = await defaultCheckHarness(env);
    expect(row).toEqual({
      id: "harness",
      label: "Agent harness",
      status: "ok",
      detail: "claude-code",
    });
  });

  test("reports the resolver's not-installed message when nothing is on PATH", async () => {
    const env = { AGENT_HARNESS: "claude-code", PATH: binDir };
    const row = await defaultCheckHarness(env, harnessEnvScopes(env, workspaceDir));
    expect(row.status).toBe("fail");
    expect(row.detail).toContain('Harness "claude-code" is not installed (looked for "claude")');
  });

  test("reports the failing repo when repos disagree", async () => {
    const cli = fakeCli("claude-custom");
    const bogus = join(binDir, "missing");
    const repos = [
      { name: "good", remote: "r", env: { CLAUDE_CODE_CLI_PATH: cli } },
      { name: "bad", remote: "r", env: { CLAUDE_CODE_CLI_PATH: bogus } },
    ] as unknown as Parameters<typeof harnessEnvScopes>[2];
    const env = { AGENT_HARNESS: "claude-code", PATH: binDir };
    const row = await defaultCheckHarness(env, harnessEnvScopes(env, workspaceDir, repos));
    expect(row.status).toBe("fail");
    expect(row.detail).toStartWith(`repo "bad": claude-code: CLAUDE_CODE_CLI_PATH=${bogus}`);
    expect(row.detail).toContain('[repos.env] of "bad"');
  });
});
