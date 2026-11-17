/**
 * End-to-end coverage for the agent outcome marker: the real CLI runs a
 * materialized markdown task against a stub agent, and the run record in an
 * isolated queue database must reflect what the agent reported. Covers the
 * two shapes automations run in: `--no-git` (`open_pr = false`) and
 * `--allow-no-changes` in a git checkout (a no-op delivery).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { RunStore } from "../src/lib/state/run-recorder";
import type { RunRecord, RunStageRecord } from "../src/lib/state/run-recorder";
import { RUN_OUTCOME_FILE_ENV, readRunOutcomeHint } from "../src/lib/worker/run-outcome-protocol";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");
const CLI_TIMEOUT_MS = 30_000;

const SUMMARY = `<!-- devintern:summary:start -->
## Why
Release the package.
## What changed
Nothing was published.
## Scope
Release only.
## Tradeoffs
None.
## Blast Radius
None.
## Verification
Ran the release checks.
<!-- devintern:summary:end -->`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outcome-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write an executable stub agent that prints `stdout` and exits 0. */
function writeStubAgent(stdout: string): string {
  const reportPath = join(dir, "agent-report.txt");
  writeFileSync(reportPath, stdout);
  const agentPath = join(dir, "agent.sh");
  writeFileSync(agentPath, `#!/bin/sh\ncat "${reportPath}"\nexit 0\n`);
  chmodSync(agentPath, 0o755);
  return agentPath;
}

/** Git identity for fixture commits and the CLI: CI runners have no global one. */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, ...GIT_IDENTITY_ENV },
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

interface CliRun {
  exitCode: number;
  output: string;
  run: RunRecord;
  outcomeStage?: RunStageRecord;
  hint: ReturnType<typeof readRunOutcomeHint>;
}

const PLAIN_TASK = "# Release\n\nPublish the next release.\n";

async function runCli(
  agentStdout: string,
  flags: string[],
  cwd = dir,
  taskContent = PLAIN_TASK,
): Promise<CliRun> {
  const dbPath = join(dir, "queue.db");
  const hintPath = join(dir, "outcome.json");
  const taskFile = join(cwd, "release.md");
  writeFileSync(taskFile, taskContent);
  const proc = Bun.spawn({
    cmd: ["bun", CLI_PATH, taskFile, "--skip-clarity-check", ...flags],
    cwd,
    env: {
      ...process.env,
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_OUTPUT_DIR: join(dir, "output"),
      WEBHOOK_QUEUE_DB: dbPath,
      [RUN_OUTCOME_FILE_ENV]: hintPath,
      ...GIT_IDENTITY_ENV,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), CLI_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const store = new RunStore(dbPath, { readonly: true });
  try {
    const [run] = store.listRuns();
    if (!run) throw new Error(`no run recorded\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    return {
      exitCode,
      output: stdout + stderr,
      run,
      outcomeStage: store.listStages(run.id).find((stage) => stage.stage === "outcome"),
      hint: readRunOutcomeHint(hintPath),
    };
  } finally {
    store.close();
  }
}

const BLOCKED = `${SUMMARY}\n<!-- devintern:outcome status=blocked reason="the unit test gate did not pass" -->\n`;

const SHAPES: Array<{ name: string; flags: () => Promise<string[]> }> = [
  { name: "--no-git (open_pr = false)", flags: async () => ["--no-git"] },
  {
    name: "--no-git --allow-no-changes",
    flags: async () => ["--no-git", "--allow-no-changes"],
  },
  {
    name: "--allow-no-changes in a git checkout",
    flags: async () => {
      await git(dir, "init", "-q", "-b", "main");
      writeFileSync(
        join(dir, ".gitignore"),
        "output/\nqueue.db*\noutcome.json\nagent*\nrelease.md\n",
      );
      await git(dir, "add", ".gitignore");
      await git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
      return ["--allow-no-changes"];
    },
  },
];

describe("agent outcome marker → run status", () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      test("status=blocked records an escalated run with the reason", async () => {
        const flags = await shape.flags();
        const result = await runCli(BLOCKED, [...flags, "--agent-path", writeStubAgent(BLOCKED)]);
        expect(result.exitCode).toBe(0);
        expect(result.run.status).toBe("escalated");
        expect(result.run.outcomeReason).toBe("blocked: the unit test gate did not pass");
        expect(result.outcomeStage?.status).toBe("escalated");
        expect(result.outcomeStage?.summary).toBe("blocked: the unit test gate did not pass");
        expect(result.hint).toEqual({
          status: "escalated",
          reason: "blocked: the unit test gate did not pass",
        });
      }, 40_000);

      test("no marker keeps a succeeded run", async () => {
        const flags = await shape.flags();
        const result = await runCli(SUMMARY, [...flags, "--agent-path", writeStubAgent(SUMMARY)]);
        expect(result.exitCode).toBe(0);
        expect(result.run.status).toBe("succeeded");
        expect(result.run.outcomeReason).toBeUndefined();
        expect(result.hint?.status).toBe("succeeded");
      }, 40_000);
    });
  }

  test("status=noop keeps a succeeded run", async () => {
    const report = `${SUMMARY}\n<!-- devintern:outcome status=noop reason="main is green" -->\n`;
    const result = await runCli(report, ["--no-git", "--agent-path", writeStubAgent(report)]);
    expect(result.run.status).toBe("succeeded");
    expect(result.run.outcomeReason).toBeUndefined();
  }, 40_000);

  test("a malformed marker keeps a succeeded run", async () => {
    const report = `${SUMMARY}\n<!-- devintern:outcome status=BLOCKED reason=unquoted -->\n`;
    const result = await runCli(report, ["--no-git", "--agent-path", writeStubAgent(report)]);
    expect(result.run.status).toBe("succeeded");
  }, 40_000);

  test("status=partial stays succeeded and records the reason", async () => {
    const report = `${SUMMARY}\n<!-- devintern:outcome status=partial reason="one of two tickets created" -->\n`;
    const result = await runCli(report, ["--no-git", "--agent-path", writeStubAgent(report)]);
    expect(result.run.status).toBe("succeeded");
    expect(result.run.outcomeReason).toBe("partial: one of two tickets created");
  }, 40_000);

  describe("markdown task status", () => {
    const TASK_WITH_STATUS = "---\nstatus: Todo\n---\n# Release\n\nPublish the next release.\n";
    const taskStatus = () =>
      /^status:\s*(.+)$/m.exec(readFileSync(join(dir, "release.md"), "utf8"))?.[1]?.trim();

    test("status=blocked leaves the task file out of Done", async () => {
      const result = await runCli(
        BLOCKED,
        ["--no-git", "--agent-path", writeStubAgent(BLOCKED)],
        dir,
        TASK_WITH_STATUS,
      );
      expect(result.run.status).toBe("escalated");
      expect(taskStatus()).not.toBe("Done");
    }, 40_000);

    test("a clean run still marks the task file Done", async () => {
      const result = await runCli(
        SUMMARY,
        ["--no-git", "--agent-path", writeStubAgent(SUMMARY)],
        dir,
        TASK_WITH_STATUS,
      );
      expect(result.run.status).toBe("succeeded");
      expect(taskStatus()).toBe("Done");
    }, 40_000);
  });
});
