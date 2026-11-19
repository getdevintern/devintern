/**
 * Retry a failed automation run through the standalone `devintern dashboard`
 * (retryMode `spawn`), against the built CLI.
 *
 * Production behavior under test
 * (`packages/code/src/lib/observability/dashboard-api.ts`):
 * - `handleRetryRun`: a terminal run with an `automationId` is eligible with
 *   `kind: "automation"` and goes to `retryAutomationRun`, which never forces
 *   the occurrence-file stem as a tracker key.
 * - `retryAutomationRun`: 404 when the automation is no longer configured,
 *   409 while a run of it is in progress, the spawn-mode claim
 *   (`claimAutomationRun`), then the regular manual trigger
 *   (`loadStandaloneAutomationActions` in `lib/automation/manual.ts`). It
 *   returns 202 `{ status: "triggered", runId, automationId }` and writes one
 *   `triggered` audit row on the retried run.
 *
 * The failed run comes from a first dashboard's Run now. A second dashboard
 * process serves the retry, because the first one's spawn-mode claim on the
 * automation outlives the run for its 60 s TTL.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DashboardFixture,
  dashboardWriteHeaders,
  writeProjectAutomations,
} from "../../helpers/dashboard";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomation } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

// Midnight on January 1st: nothing schedules it during the test (no daemon).
const NEVER_CRON = "0 0 1 1 *";
const AUTOMATION_ID = "e2e-standalone-automation-retry";
const SEED_GREETING = 'export const greeting = "Hello";\n';
const EDITED_GREETING = 'export const greeting = "Hello, world!";\n';

interface RunDetailResponse {
  run: { id: number; status: string; origin: string; automationId?: string };
  retry: {
    eligible: boolean;
    kind?: string;
    reason?: string;
    audit: Array<{ runId: number; actor: string; action: string; message?: string }>;
  };
}

async function post(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: dashboardWriteHeaders(baseUrl),
  });
  return { status: response.status, body: await response.json() };
}

async function runDetail(baseUrl: string, id: number): Promise<RunDetailResponse> {
  const response = await fetch(`${baseUrl}/api/runs/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RunDetailResponse;
}

test.skipIf(!builtCli)(
  "POST /api/runs/:id/retry on the standalone dashboard re-runs a failed automation once and refuses overlap and removed automations",
  async () => {
    const automation: WorkerAutomation = {
      id: AUTOMATION_ID,
      cron: NEVER_CRON,
      prompt: "Change the greeting to Hello, world! and run bun test.",
      // `--no-git`: the spawned run edits the project checkout in place.
      openPr: false,
    };
    const worker = new WorkerFixture({ rootPrefix: "devintern-e2e-dashboard-automation-retry-" });
    // The first agent invocation fails before editing; the retry implements.
    const failOnce = join(worker.root, "fail-once");
    worker.env.E2E_FAIL_ONCE_FILE = failOnce;
    const dashboards: DashboardFixture[] = [];
    const startDashboard = async (env: Record<string, string> = {}) => {
      const dashboard = await DashboardFixture.start(worker, {
        cwd: worker.seed,
        args: ["--no-tailscale-autodetect"],
        env: { DASHBOARD_TAILSCALE_AUTODETECT: "0", ...env },
      });
      dashboards.push(dashboard);
      return dashboard;
    };
    try {
      await worker.prepare();
      const project = worker.seed;
      const automationsFile = writeProjectAutomations(project, [automation]);
      writeFileSync(failOnce, "1");
      const greeting = () => readFileSync(join(project, "src/greeting.ts"), "utf8");
      const diagnostics = () =>
        [
          `runs: ${JSON.stringify(worker.automationRuns(AUTOMATION_ID))}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          ...dashboards.map(
            (dashboard, index) =>
              `dashboard ${index} stdout:\n${dashboard.stdout}\nstderr:\n${dashboard.stderr}`,
          ),
        ].join("\n");

      // --- 1. One failed manual run from a first dashboard ------------------
      const first = await startDashboard();
      expect(await post(first.baseUrl, `/api/automations/${AUTOMATION_ID}/run`)).toEqual({
        status: 202,
        body: { status: "triggered", automationId: AUTOMATION_ID },
      });
      const failed = await worker.waitForAutomationRun(AUTOMATION_ID, 60_000);
      expect(failed.status, diagnostics()).toBe("failed");
      expect(failed.origin, diagnostics()).toBe("manual");
      expect(existsSync(failOnce), diagnostics()).toBe(false);
      expect(greeting(), diagnostics()).toBe(SEED_GREETING);
      expect(await first.stop()).toBe(0);

      // --- 2. Retry through a fresh dashboard -------------------------------
      // The delay keeps the retried run in progress long enough to prove the
      // overlap refusal against a real run row.
      const dashboard = await startDashboard({ E2E_AGENT_DELAY_MS: "4000" });
      const baseUrl = dashboard.baseUrl;
      const retryPath = `/api/runs/${failed.id}/retry`;

      const before = await runDetail(baseUrl, failed.id);
      expect(before.run).toMatchObject({ status: "failed", automationId: AUTOMATION_ID });
      expect(before.retry).toEqual({ eligible: true, kind: "automation", audit: [] });

      const accepted = await post(baseUrl, retryPath);
      expect(accepted, diagnostics()).toEqual({
        status: 202,
        body: { status: "triggered", runId: failed.id, automationId: AUTOMATION_ID },
      });

      const active = await worker.waitFor(
        "the retried automation run to start",
        () => worker.automationRuns(AUTOMATION_ID)[1],
        30_000,
      );
      expect(active.status, diagnostics()).toBe("in_progress");

      // A second retry while that run is live is refused before any claim or
      // spawn, with the documented in-progress message.
      const overlap = await post(baseUrl, retryPath);
      expect(overlap, diagnostics()).toEqual({
        status: 409,
        body: {
          error: `automation "${AUTOMATION_ID}" already has a run in progress (run ${active.id}); wait for it to finish`,
        },
      });

      const retried = await worker.waitFor(
        "the retried automation run to settle",
        () => {
          const run = worker.automationRuns(AUTOMATION_ID)[1];
          return run && run.status !== "in_progress" ? run : undefined;
        },
        60_000,
      );
      expect(retried.status, diagnostics()).toBe("succeeded");
      expect(retried.origin, diagnostics()).toBe("manual");
      expect(retried.automation_id, diagnostics()).toBe(AUTOMATION_ID);
      // Exactly one new run and one new agent invocation: the refused retry
      // spawned nothing.
      expect(worker.automationRuns(AUTOMATION_ID), diagnostics()).toHaveLength(2);
      expect(worker.agentInvocations(), diagnostics()).toEqual([
        { mode: "implement", automation: AUTOMATION_ID },
        { mode: "implement", automation: AUTOMATION_ID },
      ]);
      expect(greeting(), diagnostics()).toBe(EDITED_GREETING);
      expect(await worker.remoteBranches(), diagnostics()).toEqual([worker.baseBranch]);

      // The retry is audited once on the failed run, with the dashboard actor.
      const after = await runDetail(baseUrl, failed.id);
      expect(after.run.status).toBe("failed");
      expect(after.retry.audit, diagnostics()).toEqual([
        expect.objectContaining({
          runId: failed.id,
          actor: "local-dashboard",
          action: "triggered",
          message: `re-ran automation "${AUTOMATION_ID}"`,
        }),
      ]);
      const succeeded = await runDetail(baseUrl, retried.id);
      expect(succeeded.retry).toMatchObject({
        eligible: false,
        reason: "this run already succeeded",
      });

      // --- 3. Removed from the config: 404, nothing spawned ------------------
      // A different, valid entry replaces it, so the catalog parses and the
      // 404 is about the missing id rather than a broken file.
      writeProjectAutomations(project, [{ ...automation, id: "e2e-unrelated-automation" }]);
      expect(readFileSync(automationsFile, "utf8")).not.toContain(AUTOMATION_ID);
      const removed = await post(baseUrl, retryPath);
      expect(removed, diagnostics()).toEqual({
        status: 404,
        body: {
          error: `automation "${AUTOMATION_ID}" not found; re-enable it in the config first`,
        },
      });
      expect(worker.automationRuns(AUTOMATION_ID), diagnostics()).toHaveLength(2);
      expect(worker.agentInvocations(), diagnostics()).toHaveLength(2);
      expect((await runDetail(baseUrl, failed.id)).retry.audit, diagnostics()).toHaveLength(1);

      expect(await dashboard.stop()).toBe(0);
    } finally {
      for (const dashboard of dashboards) {
        await dashboard.stop().catch(() => undefined);
      }
      await worker.dispose();
    }
  },
  120_000,
);
