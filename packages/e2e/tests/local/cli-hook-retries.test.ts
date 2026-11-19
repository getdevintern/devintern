import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maxTurnsValues, recordedArgv, writeArgvRecorder } from "../../helpers/argv-recorder";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";

/** Dedicated fixture credential; it must never surface in hook logs. */
const FIXTURE_TOKEN = "e2e-hook-retries-fixture-token";

/** The hook's recognizable rejection line, printed to stderr. */
const HOOK_REJECTION = "E2E pre-commit hook rejected src/greeting.ts";

type HookFix = "fix" | "fix-commit" | "noop";

/**
 * Seed a local bare remote and install a real pre-commit hook that rejects any
 * commit whose staged `src/greeting.ts` still carries the scenario's marker.
 *
 * The fixture pins `core.hooksPath=/dev/null` through `GIT_CONFIG_*` so host
 * hooks never run; this repoints that same entry at the scenario's own hooks
 * directory after seeding, so only the production commit (and the fake
 * agent's own commit) go through the hook.
 *
 * @param run - Fixture workspace whose isolated environment is reused
 * @param hookFix - What the fake agent does on the hook-repair prompt
 * @returns The marker token the implementation edit plants
 */
async function prepareHookedRemote(run: FixtureWorkspace, hookFix: HookFix): Promise<string> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, FIXTURE_TOKEN, {});

  const marker = `E2EHOOKMARKER${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const hooksDir = join(run.root, "hooks");
  mkdirSync(hooksDir);
  writeFileSync(
    join(hooksDir, "pre-commit"),
    [
      "#!/bin/sh",
      `if git show :src/greeting.ts | grep -q '${marker}'; then`,
      `  echo '${HOOK_REJECTION}: remove the hook marker' >&2`,
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  if (run.env.GIT_CONFIG_KEY_2 !== "core.hooksPath") {
    throw new Error("Fixture no longer pins core.hooksPath in GIT_CONFIG_KEY_2");
  }
  run.env.GIT_CONFIG_VALUE_2 = hooksDir;
  run.env.E2E_HOOK_MARKER = marker;
  run.env.E2E_HOOK_FIX = hookFix;
  return marker;
}

/** Number of hook-repair turns the fake agent recorded. */
function hookFixInvocations(run: FixtureWorkspace): number {
  return run.agentInvocations().filter((entry) => entry.mode === "hook-fix").length;
}

/** Per-task hook error log written by `logHookErrorToFile`. */
function hookErrorLog(run: FixtureWorkspace): string {
  return join(run.env.DEVINTERN_OUTPUT_DIR, run.taskKey.toLowerCase(), "git-hook-errors.log");
}

/** Combined CLI output for line assertions. */
function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Assert the run delivered nothing: no feature branch on the remote and a
 * non-succeeded run record.
 *
 * @param run - Fixture workspace that ran the task
 */
async function expectNothingDelivered(run: FixtureWorkspace): Promise<void> {
  expect(await run.git("ls-remote", "origin", "refs/heads/feature/*")).toBe("");
  const statuses = run.runRecords().map((record) => record.status);
  expect(statuses).toHaveLength(1);
  expect(statuses[0]).not.toBe("succeeded");
}

test.skipIf(!existsSync(cliPath))(
  "a failing pre-commit hook is repaired by the agent and the retried commit is pushed",
  async () => {
    const run = new FixtureWorkspace();
    try {
      const marker = await prepareHookedRemote(run, "fix");
      const result = await run.runTask({ extraArgs: ["--hook-retries", "2"] });
      const text = output(result);

      expect(result.exitCode).toBe(0);
      expect(text).toContain("Git hook failed (attempt 1/3)");
      expect(text).not.toContain("Git hook failed (attempt 2/3)");
      // The fix agent left the commit to the production loop, which retried it
      // through the hook rather than bypassing it.
      expect(text).toContain("Retrying commit after Agent fixed the issues");
      expect(text).not.toContain("Max retries");
      expect(hookFixInvocations(run)).toBe(1);
      expect(run.agentInvocations().map((entry) => entry.mode)).toEqual(["implement", "hook-fix"]);

      // One implementation commit, pushed, without the rejected marker.
      const tip = await run.remoteSha(run.head);
      expect(tip).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("1");
      expect(await run.git("log", "-1", "--format=%s")).toStartWith(`feat: implement ${run.id}`);
      const delivered = await run.git("show", `${tip}:src/greeting.ts`);
      expect(delivered).toBe('export const greeting = "Hello, world!";');
      expect(delivered).not.toContain(marker);
      expect(await run.git("status", "--porcelain")).toBe("");

      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
      const log = readFileSync(hookErrorLog(run), "utf8");
      expect(log).toContain("Hook Type: commit");
      expect(log).toContain("Attempt: 1");
      expect(log).toContain("Status: FIXED");
      expect(log).toContain(HOOK_REJECTION);
      expect(log).not.toContain("Attempt: 2");
      expect(log.includes(FIXTURE_TOKEN)).toBe(false);
      expect(log.includes(encodeURIComponent(FIXTURE_TOKEN))).toBe(false);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "an unrepairable pre-commit hook stops at the --hook-retries cap and delivers nothing",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareHookedRemote(run, "noop");
      const result = await run.runTask({ extraArgs: ["--hook-retries", "1"] });
      const text = output(result);

      expect(result.exitCode).not.toBe(0);
      expect(text).toContain("Git hook failed (attempt 1/2)");
      expect(text).not.toContain("Git hook failed (attempt 2/2)");
      expect(text).toContain("Max retries (1) exceeded for git hook fixes");
      // Exactly one repair turn: the second hook failure hits the cap instead
      // of invoking the agent again.
      expect(hookFixInvocations(run)).toBe(1);
      expect(run.agentInvocations().map((entry) => entry.mode)).toEqual(["implement", "hook-fix"]);

      // The hook was never bypassed: nothing was committed or pushed.
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
      await expectNothingDelivered(run);

      const log = readFileSync(hookErrorLog(run), "utf8");
      expect(log).toContain("Attempt: 1");
      expect(log).not.toContain("Attempt: 2");
      expect(log.includes(FIXTURE_TOKEN)).toBe(false);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "--hook-retries 0 fails the commit immediately without a repair turn",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareHookedRemote(run, "fix");
      const result = await run.runTask({ extraArgs: ["--hook-retries", "0"] });
      const text = output(result);

      expect(result.exitCode).not.toBe(0);
      expect(text).toContain(HOOK_REJECTION);
      expect(text).not.toContain("Git hook failed (attempt");
      expect(text).toContain("Max retries (0) exceeded for git hook fixes");
      expect(hookFixInvocations(run)).toBe(0);
      expect(run.agentInvocations().map((entry) => entry.mode)).toEqual(["implement"]);

      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
      await expectNothingDelivered(run);
      expect(existsSync(hookErrorLog(run))).toBe(false);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "a hook-fix agent that commits itself is delivered without a duplicate commit",
  async () => {
    const run = new FixtureWorkspace();
    try {
      const marker = await prepareHookedRemote(run, "fix-commit");
      const result = await run.runTask({ extraArgs: ["--hook-retries", "2"] });
      const text = output(result);

      expect(result.exitCode).toBe(0);
      expect(text).toContain("Git hook failed (attempt 1/3)");
      expect(text).toContain("Commit already completed during hook fix");
      expect(text).not.toContain("Retrying commit after");
      expect(hookFixInvocations(run)).toBe(1);

      // Only the agent's own (hook-checked) commit: no pipeline duplicate.
      const tip = await run.remoteSha(run.head);
      expect(tip).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("1");
      expect(await run.git("log", "-1", "--format=%s")).toBe(
        "fix: resolve pre-commit hook failures",
      );
      expect(await run.git("show", `${tip}:src/greeting.ts`)).not.toContain(marker);
      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

/**
 * Put the argv recorder at the fixture's agent path (`bin/agent.ts`, which
 * `runTask` passes as `--agent-path`) and move the fake agent behind it.
 *
 * @param run - Prepared fixture workspace
 * @returns JSON-lines log of every harness argv
 */
function recordHarnessArgv(run: FixtureWorkspace): string {
  const agent = join(run.root, "bin/agent.ts");
  const delegate = join(run.root, "bin/fake-agent.ts");
  renameSync(agent, delegate);
  const log = join(run.root, "harness-argv.jsonl");
  writeArgvRecorder(agent, delegate, log);
  return log;
}

test.skipIf(!existsSync(cliPath))(
  "--max-turns reaches the harness argv for the implementation and hook-fix invocations",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareHookedRemote(run, "fix");
      const log = recordHarnessArgv(run);
      const result = await run.runTask({ extraArgs: ["--hook-retries", "1", "--max-turns", "7"] });

      expect(result.exitCode, output(result)).toBe(0);
      expect(run.agentInvocations().map((entry) => entry.mode)).toEqual(["implement", "hook-fix"]);
      const invocations = recordedArgv(log);
      expect(invocations).toHaveLength(2);
      // claude-code (the fixture's AGENT_HARNESS) receives exactly one cap of 7
      // on both the implementation turn and the git-hook repair turn.
      for (const argv of invocations) expect(maxTurnsValues(argv)).toEqual(["7"]);
      expect(invocations[1]?.join(" ")).toContain("# Git Hook Error - Fix Required");
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "omitting --max-turns passes the default cap of 500 to every harness invocation",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareHookedRemote(run, "fix");
      const log = recordHarnessArgv(run);
      const result = await run.runTask({ extraArgs: ["--hook-retries", "1"] });

      expect(result.exitCode, output(result)).toBe(0);
      const invocations = recordedArgv(log);
      expect(invocations).toHaveLength(2);
      for (const argv of invocations) expect(maxTurnsValues(argv)).toEqual(["500"]);
    } finally {
      run.dispose();
    }
  },
  60_000,
);
