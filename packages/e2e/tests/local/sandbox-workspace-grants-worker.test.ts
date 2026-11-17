/**
 * End-to-end coverage for the workspace write grants a sandboxed agent gets.
 *
 * The default sandbox policy grants only the checkout, its git admin dirs, the
 * task output dir and the temp dir. `agentSandboxPolicy()` in
 * `packages/code/src/lib/agent/sandbox.ts` adds exactly `<workspace>/injected/`,
 * `<workspace>/state/` and `<workspace>/automations/` (when they exist) so an
 * agent can delegate with `devintern worker add` and automations can write
 * under their own directory. This suite runs the real built worker with
 * `AGENT_SANDBOX=nono` and the deterministic fake agent, and proves both
 * directions: the grants work, and `workspace.toml`, `.env`, `repos/` and a
 * path outside the workspace stay denied.
 *
 * The fixture root lives outside the OS temp dir: nono's Linux profile grants
 * write on `/tmp`, so a workspace beneath it could never prove a denied write.
 * A second, unsandboxed run (`AGENT_SANDBOX=none`) shows the same probes do
 * succeed without confinement, so the denials are not vacuous.
 */

import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildDefaultSandboxPolicy } from "@devintern/agent-harness";
import {
  createSandboxHome,
  createSandboxOutside,
  isAtOrBelow,
  nonoPath,
} from "../../helpers/sandbox";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const AUTOMATION_ID = "sandbox-write";
// Never fires on its own (midnight, January 1st). The test moves the durable
// cursor into the past and restarts, as worker-automations.test.ts does.
const NEVER_CRON = "0 0 1 1 *";
const DELEGATING_BODY =
  "Change the greeting to Hello, world! and run bun test. E2ESANDBOXDELEGATE E2EPROMPTMARKERDELEGATING";
const ENV_SENTINEL =
  "# e2e sandbox sentinel: must stay unchanged\nE2E_SANDBOX_SENTINEL=unchanged\n";

const cliMissing = existsSync(cliPath)
  ? undefined
  : "built CLI missing (run `bun run --filter @getdevintern/code build`)";
const nonoSkipReason =
  cliMissing ?? (nonoPath() === undefined ? "nono is not installed on PATH" : undefined);

/** Shape the fake agent writes to `<output>/e2e-sandbox-delegate.json`. */
interface DelegateReport {
  nono: boolean;
  workerAdd: { exitCode: number; json: { id?: unknown } | null; stdout: string; stderr: string };
  writes: Record<
    "workspaceToml" | "workspaceEnv" | "repos" | "outside",
    { ok: boolean; code?: string } | undefined
  >;
}

/**
 * Temp roots nono grants write on that contain `path` (empty when none do).
 *
 * @param path - Existing directory to check.
 * @returns The OS temp dir and, on Linux, `/tmp`, when `path` is at or below them.
 */
function tempRootsContaining(path: string): string[] {
  const real = realpathSync(path);
  const roots = [tmpdir(), ...(process.platform === "linux" ? ["/tmp"] : [])];
  return roots.filter((r) => existsSync(r) && isAtOrBelow(real, realpathSync(r)));
}

/**
 * Default-policy writable paths that contain the workspace, computed by the
 * real `buildDefaultSandboxPolicy` with the fixture's TMPDIR and HOME.
 *
 * @param worker - Prepared worker fixture.
 * @returns Writable paths at or above `worker.workspaceDir` (should be empty).
 */
function defaultGrantsContainingWorkspace(worker: WorkerFixture): string[] {
  const saved = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
  let writable: string[];
  try {
    process.env.TMPDIR = worker.env.TMPDIR;
    process.env.HOME = worker.env.HOME;
    writable = buildDefaultSandboxPolicy(worker.env.DEVINTERN_OUTPUT_DIR!).writablePaths;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const workspace = realpathSync(worker.workspaceDir);
  return writable.filter((p) => existsSync(p) && isAtOrBelow(workspace, realpathSync(p)));
}

/** Every resource one scenario creates, so `finally` can release all of it. */
interface GrantScenario {
  worker: WorkerFixture;
  outside: string | undefined;
  outputDir: string;
  tomlBefore: string;
  envPath: string;
}

/**
 * Create (but do not seed) a worker whose workspace sits outside the temp dir,
 * with a scheduled automation so the daemon has configured work before any
 * task is enqueued. Synchronous, so the caller holds every created resource
 * before anything async can fail.
 */
function createScenario(provider: "nono" | "none"): GrantScenario {
  const outside = createSandboxOutside();
  const root = createSandboxHome("devintern-e2e-sandbox-grants-");
  if (provider === "nono") {
    const under = tempRootsContaining(root);
    if (under.length > 0) {
      rmSync(root, { recursive: true, force: true });
      if (outside) rmSync(outside, { recursive: true, force: true });
      throw new Error(
        `fixture root ${root} landed under the temp dir (${under.join(", ")}), which nono grants write on; denials cannot be proven. Make /var/tmp or packages/e2e/node_modules/.cache writable.`,
      );
    }
  }
  // The fixture's default TMPDIR is its root; the default policy grants the
  // temp scope, which would make the whole workspace writable. Keep it
  // separate, and one level deeper: on macOS the policy grants
  // dirname(tmpdir()) (the /var/folders/<x>/<hash> parent of T), so a TMPDIR
  // of <root>/tmp would grant <root> itself, workspace included.
  const temp = join(root, "tmp", "T");
  mkdirSync(temp, { recursive: true });
  const worker = new WorkerFixture({
    root,
    workerTaskArgs: "--create-pr --skip-clarity-check --skip-comments",
    automations: [
      {
        id: AUTOMATION_ID,
        cron: NEVER_CRON,
        prompt: "E2E_NO_CHANGE: E2ESANDBOXAUTOMATIONWRITE write the automation report.",
        openPr: false,
        allowNoChanges: true,
      },
    ],
    env: {
      TMPDIR: temp,
      AGENT_SANDBOX: provider,
      E2E_DEVINTERN_CLI: cliPath,
      E2E_SANDBOX_DELEGATE_REPO: "fixture",
      E2E_SANDBOX_DELEGATE_KEY: `e2e-delegate-${crypto.randomUUID()}`,
      ...(outside ? { E2E_SANDBOX_OUTSIDE: outside } : {}),
    },
  });
  const outputDir = worker.env.DEVINTERN_OUTPUT_DIR!;
  const envPath = join(worker.workspaceDir, ".env");
  return { worker, outside, outputDir, tomlBefore: "", envPath };
}

/**
 * Give the isolated HOME the layout a real install has.
 *
 * In production the workspace (`~/.devintern`), the Bun runtime and the
 * installed CLI all live under `$HOME`, and nono's v1 policy grants read on
 * each top-level `$HOME` entry ("reads stay open"). The fixture keeps them
 * elsewhere, so mirror that with top-level symlinks (granted by their target)
 * and move the agent under `$HOME/bin`. These are read grants only; writes
 * still come exclusively from the policy's writable set.
 */
function mirrorHomeLayout(worker: WorkerFixture): void {
  const home = worker.env.HOME!;
  symlinkSync(dirname(realpathSync(process.execPath)), join(home, "e2e-bun-runtime"));
  symlinkSync(dirname(realpathSync(cliPath)), join(home, "e2e-devintern-cli"));
  symlinkSync(realpathSync(worker.workspaceDir), join(home, "e2e-workspace"));
  const agent = join(home, "bin", "agent.ts");
  mkdirSync(dirname(agent), { recursive: true });
  copyFileSync(worker.env.AGENT_CLI_PATH!, agent);
  chmodSync(agent, 0o700);
  worker.env.AGENT_CLI_PATH = agent;
}

/** Seed the workspace and plant the sentinel `.env` the agent must not change. */
async function prepareScenario(scenario: GrantScenario): Promise<void> {
  const { worker, outputDir, envPath } = scenario;
  await worker.prepare();
  mirrorHomeLayout(worker);
  // The agent's own records must land in a granted path (the task output dir);
  // the fixture default (its root) is outside the sandbox.
  mkdirSync(outputDir, { recursive: true });
  worker.env.E2E_AGENT_INVOCATIONS = join(outputDir, "agent-invocations.jsonl");
  worker.env.E2E_AGENT_TIMELINE = join(outputDir, "agent-timeline.jsonl");
  writeFileSync(envPath, ENV_SENTINEL);
  scenario.tomlBefore = readFileSync(join(worker.workspaceDir, "workspace.toml"), "utf8");
}

/** Start the daemon and enqueue the delegating task; return the delegate report. */
async function runDelegation(scenario: GrantScenario) {
  const { worker } = scenario;
  worker.start();
  await worker.waitForReady();
  const first = await worker.addTask({ title: "Delegate from a sandbox", body: DELEGATING_BODY });
  const settled = await worker.waitForSettled(first.id, 60_000);
  const reportPath = join(scenario.outputDir, "e2e-sandbox-delegate.json");
  expect(existsSync(reportPath), `delegate report missing\n${worker.tail()}`).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as DelegateReport;
  return { first, settled, report };
}

async function disposeScenario(scenario: GrantScenario | undefined): Promise<void> {
  if (!scenario) return;
  const failures: string[] = [];
  try {
    await scenario.worker.dispose();
  } catch (error) {
    failures.push(`worker: ${(error as Error).message}`);
  }
  if (scenario.outside) {
    try {
      rmSync(scenario.outside, { recursive: true, force: true });
    } catch (error) {
      failures.push(`outside dir ${scenario.outside}: ${(error as Error).message}`);
    }
  }
  if (existsSync(scenario.worker.root)) failures.push(`fixture root ${scenario.worker.root}`);
  if (failures.length > 0) throw new Error(`Cleanup incomplete:\n${failures.join("\n")}`);
}

test.skipIf(nonoSkipReason !== undefined)(
  `a nono-sandboxed agent can delegate with worker add and write automations/, but not workspace config${
    nonoSkipReason ? ` [skipped: ${nonoSkipReason}]` : ""
  }`,
  async () => {
    let scenario: GrantScenario | undefined;
    try {
      scenario = createScenario("nono");
      await prepareScenario(scenario);
      const { worker } = scenario;
      const injectedDir = join(worker.workspaceDir, "injected");
      const automationsDir = join(worker.workspaceDir, "automations");
      const stateDir = join(worker.workspaceDir, "state");
      // No default grant (temp scope included) may cover the workspace, or the
      // denial assertions below would fail for a fixture reason.
      expect(defaultGrantsContainingWorkspace(worker)).toEqual([]);
      // Nothing pre-creates the granted directories: the grant only lists
      // existing paths (workspaceAgentWritablePaths), so the worker must create
      // the ones it owns at startup (ensureAgentWritableWorkspaceDirs in
      // packages/code/src/lib/workspace/workspace-worker.ts), and opening the
      // queue creates state/ (packages/code/src/lib/state/webhook-queue.ts).
      expect(existsSync(injectedDir)).toBe(false);
      expect(existsSync(automationsDir)).toBe(false);
      expect(existsSync(stateDir)).toBe(false);

      const { first, settled, report } = await runDelegation(scenario);
      expect(existsSync(injectedDir)).toBe(true);
      expect(existsSync(automationsDir)).toBe(true);
      expect(existsSync(stateDir)).toBe(true);

      // The probe ran inside nono, not unconfined.
      expect(report.nono).toBe(true);

      // Delegation from inside the sandbox succeeds.
      expect(report.workerAdd.exitCode, report.workerAdd.stderr).toBe(0);
      const delegatedId = report.workerAdd.json?.id;
      expect(typeof delegatedId).toBe("number");
      const delegated = worker.injectedTask(delegatedId as number);
      expect(delegated, "delegated row in state/queue.db").toBeDefined();
      expect(delegated!.idempotency_key).toBe(worker.env.E2E_SANDBOX_DELEGATE_KEY!);
      expect(delegated!.repo).toBe("fixture");
      expect(delegated!.task_file.startsWith(`${injectedDir}/`)).toBe(true);
      expect(existsSync(delegated!.task_file), "delegated prompt file under injected/").toBe(true);
      expect(readFileSync(delegated!.task_file, "utf8")).toContain("E2EPROMPTMARKERDELEGATED");

      // The delegating task itself completed: checkout writes stay allowed.
      expect(settled.task.status, `delegating task\n${worker.tail()}`).toBe("done");
      expect(settled.runs.at(-1)?.status).toBe("succeeded");
      expect(first.id).not.toBe(delegatedId);

      // Writes the policy must deny failed, and left nothing behind.
      expect(report.writes.workspaceToml?.ok).toBe(false);
      expect(report.writes.workspaceEnv?.ok).toBe(false);
      expect(report.writes.repos?.ok).toBe(false);
      expect(readFileSync(join(worker.workspaceDir, "workspace.toml"), "utf8")).toBe(
        scenario.tomlBefore,
      );
      expect(readFileSync(scenario.envPath, "utf8")).toBe(ENV_SENTINEL);
      expect(existsSync(join(worker.workspaceDir, "repos", "e2e-sandbox-escape"))).toBe(false);
      if (scenario.outside) {
        expect(report.writes.outside?.ok).toBe(false);
        expect(existsSync(join(scenario.outside, "sandbox-escape"))).toBe(false);
      } else {
        console.warn(
          "[sandbox-workspace-grants-worker] no directory outside the temp dir is creatable on this host; outside-write denial not asserted",
        );
      }

      // The worker picks up and completes the delegated task.
      const delegatedSettled = await worker.waitForSettled(delegatedId as number, 60_000);
      expect(delegatedSettled.task.status, worker.tail()).toBe("done");
      expect(delegatedSettled.runs.at(-1)?.status).toBe("succeeded");
      const delegatedBranch = delegatedSettled.runs.at(-1)?.branch;
      expect(delegatedBranch).toBeTruthy();
      expect(await worker.branchFile(delegatedBranch!, "src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );

      // One scheduled automation occurrence under nono writes automations/<id>/.
      await worker.stop();
      worker.setScheduleNextDue(AUTOMATION_ID, Date.now() - 1_000);
      worker.start();
      await worker.waitForReady();
      const run = await worker.waitForAutomationRun(AUTOMATION_ID, 60_000);
      expect(run.status, worker.tail()).toBe("succeeded");
      const written = join(automationsDir, AUTOMATION_ID, "e2e-sandbox-write.txt");
      expect(existsSync(written), "automation write under automations/<id>/").toBe(true);
      const automationReport = JSON.parse(
        readFileSync(join(scenario.outputDir, "e2e-sandbox-automation.json"), "utf8"),
      ) as { ok: boolean; target: string };
      expect(automationReport).toEqual({ ok: true, target: written });
    } finally {
      await disposeScenario(scenario);
    }
  },
  240_000,
);

test.skipIf(cliMissing !== undefined)(
  `without a sandbox the same probes succeed, so the nono denials are not vacuous${
    cliMissing ? ` [skipped: ${cliMissing}]` : ""
  }`,
  async () => {
    let scenario: GrantScenario | undefined;
    try {
      scenario = createScenario("none");
      await prepareScenario(scenario);
      const { worker } = scenario;
      const { settled, report } = await runDelegation(scenario);

      expect(report.nono).toBe(false);
      expect(report.workerAdd.exitCode, report.workerAdd.stderr).toBe(0);
      expect(typeof report.workerAdd.json?.id).toBe("number");
      expect(settled.task.status, worker.tail()).toBe("done");

      // Unconfined, every probe write lands: the nono test's denials are real.
      expect(report.writes.workspaceToml?.ok).toBe(true);
      expect(report.writes.workspaceEnv?.ok).toBe(true);
      expect(report.writes.repos?.ok).toBe(true);
      expect(readFileSync(scenario.envPath, "utf8")).not.toBe(ENV_SENTINEL);
      if (scenario.outside) expect(report.writes.outside?.ok).toBe(true);

      const delegatedSettled = await worker.waitForSettled(
        report.workerAdd.json!.id as number,
        60_000,
      );
      expect(delegatedSettled.task.status, worker.tail()).toBe("done");
    } finally {
      await disposeScenario(scenario);
    }
  },
  180_000,
);
