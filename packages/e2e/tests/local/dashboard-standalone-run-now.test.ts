/**
 * Automation "Run now" on the standalone `devintern dashboard` (retryMode
 * `spawn`), against the built CLI.
 *
 * Production behavior under test:
 * - `packages/code/src/lib/observability/cli.ts`: without `--workspace` the
 *   standalone server serves the project's `.devintern-code/automations.toml`
 *   through `loadStandaloneAutomationActions`
 *   (`packages/code/src/lib/automation/manual.ts`), which spawns the regular
 *   CLI pipeline for a materialized occurrence file with the `manual` origin.
 * - `packages/code/src/lib/observability/dashboard-api.ts`
 *   `handleRunAutomation`: 202 `{ status: "triggered", automationId }`; in spawn
 *   mode `claimAutomationRun` holds the automation's slot for the in-flight TTL
 *   (60 s), so a concurrent or repeated trigger is refused with 409.
 */

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DashboardFixture,
  concurrentDashboardWrites,
  dashboardWriteHeaders,
  writeProjectAutomations,
} from "../../helpers/dashboard";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomation } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

// Midnight on January 1st: the automation never comes due during the test,
// and nothing schedules it anyway (no daemon), so the only run is the manual one.
const NEVER_CRON = "0 0 1 1 *";
const AUTOMATION_ID = "e2e-standalone-run-now";

interface AutomationView {
  id: string;
  kind: string;
  enabled: boolean;
  schedule?: string;
  openPr: boolean;
  lastRun?: { id: number; origin: string; automationId?: string; status: string };
}

interface RunView {
  id: number;
  status: string;
  origin: string;
  automationId?: string;
}

interface ErrorBody {
  error: string;
}

const claimRefusal = `a manual run of "${AUTOMATION_ID}" was just triggered and is starting`;
const inProgressRefusal = new RegExp(
  `^automation "${AUTOMATION_ID}" already has a run in progress \\(run \\d+\\); wait for it to finish$`,
);

async function jsonOf<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

test.skipIf(!builtCli)(
  "POST /api/automations/:id/run on the standalone dashboard claims, spawns, and records one manual run",
  async () => {
    const automation: WorkerAutomation = {
      id: AUTOMATION_ID,
      cron: NEVER_CRON,
      prompt: "Change the greeting to Hello, world! and run bun test.",
      // `--no-git`: the spawned run edits the project checkout in place.
      openPr: false,
    };
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-dashboard-run-now-",
      // Keeps the spawned run active while the concurrent trigger lands.
      env: { E2E_AGENT_DELAY_MS: "2000" },
    });
    let dashboard: DashboardFixture | undefined;
    try {
      // No daemon: the standalone dashboard is the only thing that can start
      // the automation. The seed checkout is the single-repo project.
      await worker.prepare();
      const project = worker.seed;
      writeProjectAutomations(project, [automation]);
      dashboard = await DashboardFixture.start(worker, {
        cwd: project,
        args: ["--no-tailscale-autodetect"],
        env: { DASHBOARD_TAILSCALE_AUTODETECT: "0" },
      });
      const baseUrl = dashboard.baseUrl;
      const runNowPath = `/api/automations/${AUTOMATION_ID}/run`;
      const diagnostics = () =>
        [
          `runs: ${JSON.stringify(worker.automationRuns(AUTOMATION_ID))}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          `dashboard stdout:\n${dashboard?.stdout ?? ""}`,
          `dashboard stderr:\n${dashboard?.stderr ?? ""}`,
        ].join("\n");

      const listed = await jsonOf<{ automations: AutomationView[] }>(
        await fetch(`${baseUrl}/api/automations`),
      );
      expect(listed.automations, diagnostics()).toEqual([
        expect.objectContaining({
          id: AUTOMATION_ID,
          kind: "automation",
          enabled: true,
          schedule: NEVER_CRON,
          openPr: false,
        }),
      ]);
      expect(listed.automations[0]?.lastRun).toBeUndefined();

      // The write guard applies to run-now: no Origin creates nothing.
      const bare = await fetch(`${baseUrl}${runNowPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(bare.status).toBe(403);
      expect(await bare.json()).toEqual({ error: "forbidden: missing Origin header" });
      expect(worker.automationRuns(AUTOMATION_ID)).toEqual([]);

      // Two concurrent triggers: the in-flight claim is synchronous, so exactly
      // one spawns and the other is refused before reaching the spawn path.
      const race = await concurrentDashboardWrites<ErrorBody | Record<string, unknown>>(
        baseUrl,
        runNowPath,
      );
      const raceDiagnostics = () => `race: ${JSON.stringify(race)}\n${diagnostics()}`;
      const accepted = race.filter((result) => result.status === 202);
      const refused = race.filter((result) => result.status === 409);
      expect(accepted, raceDiagnostics()).toEqual([
        { status: 202, body: { status: "triggered", automationId: AUTOMATION_ID } },
      ]);
      expect(refused, raceDiagnostics()).toHaveLength(1);
      const refusal = String((refused[0]?.body as ErrorBody | undefined)?.error);
      // The claim refusal is the expected outcome; the in-progress check runs
      // first and wins only if the spawned CLI already opened its run row.
      expect(refusal === claimRefusal || inProgressRefusal.test(refusal), raceDiagnostics()).toBe(
        true,
      );

      const active = await worker.waitFor(
        "the spawned manual run row",
        () => worker.automationRuns(AUTOMATION_ID)[0],
        30_000,
      );
      expect(active.origin, diagnostics()).toBe("manual");
      expect(active.automation_id, diagnostics()).toBe(AUTOMATION_ID);

      const run = await worker.waitForAutomationRun(AUTOMATION_ID, 60_000);
      expect(run.status, diagnostics()).toBe("succeeded");
      expect(run.origin).toBe("manual");
      // One run and one agent invocation: the refused trigger spawned nothing.
      expect(worker.automationRuns(AUTOMATION_ID), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([
        { mode: "implement", automation: AUTOMATION_ID },
      ]);

      // The spawned pipeline ran the automation's prompt in the project and
      // materialized its occurrence file there (the standalone task-file dir).
      expect(readFileSync(join(project, "src/greeting.ts"), "utf8")).toBe(
        'export const greeting = "Hello, world!";\n',
      );
      const occurrenceDir = join(project, ".devintern-code", "automations", AUTOMATION_ID);
      expect(
        readdirSync(occurrenceDir).filter((name) => name.endsWith(".md")),
        diagnostics(),
      ).toHaveLength(1);
      // `--no-git`: no branch reached the remote.
      expect(await worker.remoteBranches(), diagnostics()).toEqual([worker.baseBranch]);

      // Run history records it under the automation id and the manual origin.
      const runs = await jsonOf<{ runs: RunView[]; total: number }>(
        await fetch(`${baseUrl}/api/runs?automationId=${AUTOMATION_ID}`),
      );
      expect(runs.total, diagnostics()).toBe(1);
      expect(runs.runs[0]).toMatchObject({
        id: run.id,
        status: "succeeded",
        origin: "manual",
        automationId: AUTOMATION_ID,
      });
      const after = await jsonOf<{ automations: AutomationView[] }>(
        await fetch(`${baseUrl}/api/automations`),
      );
      expect(after.automations[0]?.lastRun, diagnostics()).toMatchObject({
        id: run.id,
        origin: "manual",
        automationId: AUTOMATION_ID,
        status: "succeeded",
      });

      // The run finished, but the spawn-mode claim is still held for its TTL:
      // a re-trigger is debounced by `claimAutomationRun`, not the active-run
      // check, and starts nothing.
      const repeat = await fetch(`${baseUrl}${runNowPath}`, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
      });
      expect(repeat.status, diagnostics()).toBe(409);
      expect(await repeat.json()).toEqual({ error: claimRefusal });
      expect(worker.automationRuns(AUTOMATION_ID), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toHaveLength(1);

      // The dashboard logs the spawned run's completion.
      await worker.waitFor("the manual run completion log", () =>
        dashboard?.stdout.includes(`[automation:${AUTOMATION_ID}]`) ? true : undefined,
      );

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  120_000,
);
