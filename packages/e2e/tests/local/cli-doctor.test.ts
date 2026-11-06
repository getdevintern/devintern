/**
 * End-to-end coverage for the built CLI's `devintern doctor` command.
 *
 * The readiness collectors are unit-tested in `packages/code/tests/readiness.test.ts`;
 * these tests exercise the process surface: environment loading, the isolated
 * HOME, rendered output, and the exit code. Everything is local and offline:
 * the sign-in probe finds no session and the license probe is skipped.
 */

import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { cliPath } from "../../helpers/fixture-workspace";
import type { CommandResult } from "../../helpers/process";
import { command } from "../../helpers/process";

const skip = !existsSync(cliPath);

interface DoctorWorkspace {
  root: string;
  cwd: string;
  agent: string;
  env: Record<string, string>;
  run: (args?: string[], overrides?: Record<string, string | undefined>) => Promise<CommandResult>;
}

/**
 * Build a throwaway HOME/cwd with a Markdown task directory and the
 * deterministic fake agent, so doctor sees a valid local setup.
 */
function createDoctorWorkspace(): DoctorWorkspace {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-doctor-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });

  const tasks = join(root, "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, "fixture.md"), "# Doctor fixture\n\nA local Markdown task.\n");

  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const agent = join(bin, "agent.ts");
  copyFileSync(resolve(import.meta.dir, "../../helpers/fake-agent.ts"), agent);
  chmodSync(agent, 0o700);

  const env: Record<string, string> = {
    ...isolatedEnvironment(root),
    MARKDOWN_TASKS_DIR: tasks,
    AGENT_CLI_PATH: agent,
    // Doctor does not color output today; make that an explicit contract.
    NO_COLOR: "1",
    // The fake agent records every invocation, so the absence of this file
    // proves doctor only probes installation and never runs the agent.
    E2E_AGENT_INVOCATIONS: join(root, "agent-invocations.jsonl"),
  };

  return {
    root,
    cwd,
    agent,
    env,
    run: (args = [], overrides = {}) => {
      const childEnv: Record<string, string> = { ...env };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete childEnv[key];
        } else {
          childEnv[key] = value;
        }
      }
      return command([process.execPath, cliPath, "doctor", ...args], cwd, childEnv);
    },
  };
}

/** Both streams, without ANSI escapes even if color handling regresses. */
function output(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Run a scenario against a fresh workspace and always remove its temp root. */
async function withDoctorWorkspace(
  scenario: (workspace: DoctorWorkspace) => Promise<void>,
): Promise<void> {
  const workspace = createDoctorWorkspace();
  try {
    await scenario(workspace);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
}

/** The fake agent must never run just because readiness was checked. */
function expectAgentNotInvoked(workspace: DoctorWorkspace): void {
  expect(existsSync(workspace.env.E2E_AGENT_INVOCATIONS)).toBe(false);
}

/**
 * PATH containing only a git symlink, so Git still resolves but no harness CLI
 * can be discovered through the contributor's ambient PATH.
 */
function gitOnlyPath(workspace: DoctorWorkspace): string {
  const bin = join(workspace.root, "git-only-path");
  mkdirSync(bin, { recursive: true });
  const git = Bun.which("git");
  if (!git) throw new Error("git must be on the test runner PATH");
  symlinkSync(git, join(bin, "git"));
  return bin;
}

test.skipIf(skip)(
  "doctor --help exits 0 and prints the documented usage",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      const result = await workspace.run(["--help"]);
      const text = output(result);

      expect(result.exitCode).toBe(0);
      expect(text).toContain("Usage: devintern doctor");
      expect(text).toContain("Exits non-zero when any check fails.");
      expect(text).toContain("-h, --help");
      // Help must not run the readiness probes.
      expect(text).not.toContain("devintern readiness:");
    });
  },
  30_000,
);

test.skipIf(skip)(
  "a healthy local setup shows runtime, Git, agent and tracker checks as OK and warns about sign-in",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      const result = await workspace.run();
      const text = output(result);

      expect(result.exitCode).toBe(0);
      expect(text).toContain("✅ Bun runtime — v");
      expect(text).toContain("✅ Git — ");
      expect(text).toContain(`✅ AI agent CLI — Claude Code (${workspace.agent})`);
      expect(text).toContain("✅ Task tracker — markdown");
      expect(text).not.toContain("❌");

      // No session in the isolated HOME: sign-in is a warning, not a failure.
      expect(text).toContain("⚠️  DevIntern sign-in");
      expect(text).toContain("Run 'devintern login'");
      expect(text).toContain("✅ Ready to run (with the warnings above).");
      expect(text).not.toContain("❌ Not ready");

      // The sign-in probe read no session, so no refresh or license check ran.
      expect(existsSync(join(workspace.cwd, ".devintern-code/.auth-session.json"))).toBe(false);
      expect(text).not.toContain("Not required for interactive use");
      expect(text).not.toContain("Could not verify the license right now");
      expectAgentNotInvoked(workspace);
    });
  },
  30_000,
);

test.skipIf(skip)(
  "a missing MARKDOWN_TASKS_DIR environment variable exits 1 with the tracker, variable and init hint",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      // An empty value counts as missing for readiness but keeps dotenv from
      // filling it from a developer's `packages/code/.env`.
      const result = await workspace.run([], { MARKDOWN_TASKS_DIR: "" });
      const text = output(result);

      expect(result.exitCode).toBe(1);
      expect(text).toContain("❌ Task tracker — markdown: missing MARKDOWN_TASKS_DIR");
      expect(text).toContain("💡 Run 'devintern init' or edit .devintern-code/.env");
      expect(text).toContain("❌ Not ready — fix the failed checks above.");
    });
  },
  30_000,
);

test.skipIf(skip)(
  "an unsupported TASK_TRACKER exits 1 and lists the supported trackers",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      const result = await workspace.run([], { TASK_TRACKER: "not-a-tracker" });
      const text = output(result);

      expect(result.exitCode).toBe(1);
      expect(text).toContain('unsupported TASK_TRACKER value "not-a-tracker"');
      expect(text).toContain("Supported trackers:");
      expect(text).toContain("jira");
      expect(text).toContain("markdown");
      expect(text).toContain("❌ Not ready");
    });
  },
  30_000,
);

test.skipIf(skip)(
  "an unknown configured harness exits 1 with the supported-harness hint and no model call",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      const result = await workspace.run([], { AGENT_HARNESS: "not-a-harness" });
      const text = output(result);

      expect(result.exitCode).toBe(1);
      expect(text).toContain("❌ AI agent CLI");
      expect(text).toContain('Unknown agent harness: "not-a-harness"');
      expect(text).toContain("Set AGENT_HARNESS to a supported harness name");
      expect(text).toContain("❌ Not ready");
      expectAgentNotInvoked(workspace);
    });
  },
  30_000,
);

test.skipIf(skip)(
  "an uninstalled configured harness exits 1 with the install hint and no model call",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      const missing = join(workspace.root, "bin", "missing-agent");
      const result = await workspace.run([], {
        AGENT_CLI_PATH: missing,
        PATH: gitOnlyPath(workspace),
      });
      const text = output(result);

      expect(result.exitCode).toBe(1);
      expect(text).toContain("✅ Git — ");
      expect(text).toContain("❌ AI agent CLI");
      expect(text).toContain("not found on PATH");
      expect(text).toContain("Install an agent CLI");
      expect(text).toContain("AGENT_CLI_PATH");
      expect(text).toContain("❌ Not ready");
      expectAgentNotInvoked(workspace);
    });
  },
  30_000,
);

test.skipIf(skip)(
  "a PATH without Git exits 1 with the Git install hint",
  async () => {
    await withDoctorWorkspace(async (workspace) => {
      // Launch Bun by absolute path and give only this empty directory on PATH,
      // so the doctor's `git --version` probe cannot resolve Git. The test
      // runner's own PATH is untouched.
      const pathWithoutGit = join(workspace.root, "path-without-git");
      mkdirSync(pathWithoutGit, { recursive: true });
      expect(existsSync(join(pathWithoutGit, "git"))).toBe(false);

      const result = await workspace.run([], { PATH: pathWithoutGit });
      const text = output(result);

      expect(result.exitCode).toBe(1);
      expect(text).toContain("❌ Git");
      expect(text).toContain("Install git and make sure it is on your PATH");
      expect(text).toContain("❌ Not ready");
    });
  },
  30_000,
);
