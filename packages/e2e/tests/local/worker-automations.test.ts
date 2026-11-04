import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { command, checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomation, WorkerRunRecord } from "../../helpers/worker";

const implementPrompt = "Change the greeting to Hello, world! and run bun test.";
const noChangePrompt =
  "E2E_NO_CHANGE: inspect the repository and make no changes if nothing needs doing.";

const automations: WorkerAutomation[] = [
  // The workspace default flags include --create-pr; this automation keeps the
  // branch/push policy they imply. PR creation itself is not covered here: the
  // bare remote has no detectable code-host platform, so the run succeeds with
  // no pr_url. A separate fixture without --create-pr isolates this automation's
  // own open_pr opt-in.
  { id: "auto-pr-on", prompt: implementPrompt, openPr: true },
  // The workspace default flags include --create-pr; the per-automation policy
  // must strip it and add --no-git.
  { id: "auto-pr-off", prompt: implementPrompt, openPr: false },
  // Same no-change prompt, opposite allow_no_changes policy.
  { id: "noop-allowed", prompt: noChangePrompt, openPr: true, allowNoChanges: true },
  { id: "noop-blocked", prompt: noChangePrompt, openPr: true },
];

const ids = automations.map((automation) => automation.id);

test.skipIf(!existsSync(cliPath))(
  "scheduled workspace automations honor cron, open_pr and allow_no_changes",
  async () => {
    const worker = new WorkerFixture({
      maxConcurrency: 2,
      automations,
    });
    try {
      await worker.prepare();
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        new RegExp(`Scheduling ${automations.length} enabled automation`),
        20_000,
        "the automation scheduler to register every enabled entry",
      );
      await worker.waitFor("every enabled automation to have a durable schedule row", () =>
        worker.automationSchedules().length === automations.length ? true : undefined,
      );

      expect(
        worker
          .automationSchedules()
          .map((row) => row.automation_id)
          .sort(),
      ).toEqual([...ids].sort());

      const runs = new Map<string, WorkerRunRecord>();
      for (const id of ids) {
        // One cron boundary costs up to a minute; every automation shares it.
        runs.set(id, await worker.waitForAutomationRun(id, 90_000));
      }

      for (const id of ids) {
        const run = runs.get(id)!;
        expect(run.origin, `${id} origin`).toBe("scheduled");
        expect(run.automation_id, `${id} automation id`).toBe(id);
        expect(worker.automationOccurrences(id).length, `${id} occurrence file`).toBeGreaterThan(0);
        const occurrence = worker.automationOccurrences(id)[0]!;
        expect(existsSync(join(worker.workspaceDir, "automations", id, occurrence))).toBe(true);
      }

      // auto-pr-on: the per-automation policy keeps --create-pr, so the run
      // records a branch and pushes it. The bare remote exposes no code-host
      // platform, so PR creation fails without failing the run; actual PR
      // creation is covered by the code-host suites.
      const prRun = runs.get("auto-pr-on")!;
      expect(prRun.status).toBe("succeeded");
      expect(prRun.pr_url).toBeNull();
      expect(prRun.branch).not.toBeNull();
      const branch = prRun.branch!;
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(
        await checkedCommand(
          [
            "git",
            "--git-dir",
            worker.remote,
            "diff",
            "--name-only",
            `${worker.baseBranch}...${branch}`,
          ],
          worker.root,
          worker.env,
        ),
      ).toBe("src/greeting.ts");
      expect(
        await checkedCommand(
          [
            "git",
            "--git-dir",
            worker.remote,
            "rev-list",
            "--count",
            `${worker.baseBranch}..${branch}`,
          ],
          worker.root,
          worker.env,
        ),
      ).toBe("1");

      // auto-pr-off: the run still invokes the agent (asserted per automation
      // below), but the per-automation policy suppresses every push.
      const noPrRun = runs.get("auto-pr-off")!;
      expect(noPrRun.status).toBe("succeeded");
      expect(noPrRun.branch).toBeNull();
      expect(
        await remoteBranchExists(worker, `feature/${noPrRun.task_key}`),
        "auto-pr-off must not publish a feature branch",
      ).toBe(false);

      // noop-allowed: --allow-no-changes turns an unchanged run into success.
      // The local feature branch may be prepared and recorded, but nothing is
      // committed or pushed.
      const allowedRun = runs.get("noop-allowed")!;
      expect(allowedRun.status).toBe("succeeded");
      expect(allowedRun.pr_url).toBeNull();
      expect(
        await remoteBranchExists(worker, allowedRun.branch ?? `feature/${allowedRun.task_key}`),
        "noop-allowed must not publish a branch",
      ).toBe(false);

      // noop-blocked: without the flag the missing commit fails the run.
      const blockedRun = runs.get("noop-blocked")!;
      expect(blockedRun.status).toBe("failed");
      expect(blockedRun.outcome_reason).toContain("Implementation was not committed");
      expect(
        await remoteBranchExists(worker, blockedRun.branch ?? `feature/${blockedRun.task_key}`),
        "noop-blocked must not publish a branch",
      ).toBe(false);

      // No extra commits landed on the bare base branch: the no-op pair changed
      // nothing, and only auto-pr-on published work (on its feature branch).
      expect(
        await checkedCommand(
          ["git", "--git-dir", worker.remote, "rev-list", "--count", worker.baseBranch],
          worker.root,
          worker.env,
        ),
      ).toBe("1");

      // Every agent invocation is attributed to the automation that spawned
      // it, so a run that never reached the agent cannot be masked by another
      // automation's invocation.
      expect(invokedModes(worker, "auto-pr-on")).toEqual(["implement"]);
      expect(invokedModes(worker, "auto-pr-off")).toEqual(["implement"]);
      expect(invokedModes(worker, "noop-allowed")).toEqual(["no-change"]);
      expect(invokedModes(worker, "noop-blocked")).toEqual(["no-change"]);

      // Only configured, due automations ever produce a row.
      const configured = new Set(ids);
      const attributed = worker
        .runRecords()
        .map((run) => run.automation_id)
        .filter((id): id is string => id !== null);
      expect(new Set(attributed).size).toBe(ids.length);
      for (const id of attributed)
        expect(configured.has(id), `unexpected automation ${id}`).toBe(true);

      // Live reload: append an automation and wait for the next occurrence.
      const reloaded: WorkerAutomation = {
        id: "hot-reload",
        prompt: noChangePrompt,
        openPr: true,
        allowNoChanges: true,
      };
      worker.appendAutomation(reloaded);
      await worker.waitForOutput(
        /5 automation\(s\)/,
        20_000,
        "the workspace config reloader to reconcile the added automation",
      );
      await worker.waitFor("the added automation to register its schedule", () =>
        worker.automationSchedules().some((row) => row.automation_id === reloaded.id)
          ? true
          : undefined,
      );
      const reloadedRun = await worker.waitForAutomationRun(reloaded.id, 90_000);
      expect(reloadedRun.origin).toBe("scheduled");
      expect(reloadedRun.automation_id).toBe(reloaded.id);
      expect(reloadedRun.status).toBe("succeeded");
      expect(
        await remoteBranchExists(worker, reloadedRun.branch ?? `feature/${reloadedRun.task_key}`),
      ).toBe(false);
      expect(worker.automationOccurrences(reloaded.id).length).toBeGreaterThan(0);
      expect(worker.running, worker.tail()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // One boundary for the first occurrence, one for the reloaded automation,
  // plus fixture preparation and graceful shutdown.
  180_000,
);

test.skipIf(!existsSync(cliPath))(
  "scheduled automation open_pr opt-in adds --create-pr when defaults omit it",
  async () => {
    const worker = new WorkerFixture({
      // The workspace defaults omit --create-pr, so only the automation's own
      // open_pr = true can turn on the branch push and PR path.
      workerTaskArgs: "--skip-clarity-check --skip-comments",
      automations: [{ id: "opt-in-pr", prompt: implementPrompt, openPr: true }],
    });
    try {
      await worker.prepare();
      expect(readFileSync(join(worker.workspaceDir, "workspace.toml"), "utf8")).not.toContain(
        "--create-pr",
      );
      worker.start();
      await worker.waitForReady();
      await worker.waitForOutput(
        /Scheduling 1 enabled automation/,
        20_000,
        "the automation scheduler to register the opt-in entry",
      );
      const run = await worker.waitForAutomationRun("opt-in-pr", 90_000);
      expect(run.origin).toBe("scheduled");
      expect(run.status).toBe("succeeded");
      expect(run.branch).not.toBeNull();
      const branch = run.branch!;
      expect(await remoteBranchExists(worker, branch), "open_pr must push the branch").toBe(true);
      expect(await worker.branchFile(branch, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      // The bare remote has no detectable code-host platform, so PR creation
      // fails without failing the run; the code-host suites own that path.
      expect(run.pr_url).toBeNull();
      expect(invokedModes(worker, "opt-in-pr")).toEqual(["implement"]);
      expect(worker.running, worker.tail()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // One cron boundary plus fixture preparation and graceful shutdown.
  120_000,
);

async function remoteBranchExists(worker: WorkerFixture, branch: string): Promise<boolean> {
  const result = await command(
    ["git", "--git-dir", worker.remote, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    worker.root,
    worker.env,
  );
  return result.exitCode === 0;
}

/** Modes of the agent invocations attributed to one automation, in order. */
function invokedModes(worker: WorkerFixture, automationId: string): string[] {
  return worker
    .agentInvocations()
    .filter((invocation) => invocation.automation === automationId)
    .map((invocation) => invocation.mode);
}
