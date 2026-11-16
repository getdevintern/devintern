/**
 * Worker-embedded dashboard, automation "Run now", the Host/Origin guard, and
 * log readback/redaction, all against the built CLI.
 *
 * Production behavior under test:
 * - `packages/code/src/dashboard-server.ts` `checkDashboardRequest`: every
 *   `/api` request needs a loopback or allowlisted `Host` (403 otherwise, GET
 *   included); writes also need an `Origin` matching that Host (or an
 *   allowlisted origin) and a JSON content type (415).
 * - `packages/code/src/lib/observability/dashboard-api.ts` `handleRunAutomation`
 *   and `packages/code/src/lib/automation/acquirer.ts` `triggerManual`: 202
 *   `{ status: "triggered" }`, then a second trigger while the run is active is
 *   refused with 409 (the dashboard's in-progress run check, or the scheduler's
 *   "already running" active-run/lease check, whichever the timing hits).
 * - `packages/code/src/lib/observability/worker-logs.ts` `redactSecrets`.
 */

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DashboardFixture,
  dashboardBaseUrl,
  dashboardWriteHeaders,
  waitForDashboardHealth,
} from "../../helpers/dashboard";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAutomation } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

// Midnight on January 1st: the automation never comes due during the test, so
// every run it records is the manual one this test triggers.
const NEVER_CRON = "0 0 1 1 *";
const AUTOMATION_ID = "e2e-run-now";
const EVIL_ORIGIN = "https://evil.example";
// Fake, credential-shaped values only. They never reach a real service.
const FAKE_GITHUB_TOKEN = "ghp_e2eFAKEdashboardToken0123456789";
const FAKE_API_TOKEN_VALUE = "e2e-fake-api-token-value-7f3a";

interface AutomationView {
  id: string;
  kind: string;
  enabled: boolean;
  schedule?: string;
  repo?: string;
  openPr: boolean;
  nextDueAt?: number;
  lastRun?: { id: number; origin: string; automationId?: string; status: string };
}

interface RunView {
  id: number;
  status: string;
  origin: string;
  automationId?: string;
  taskKey?: string;
}

interface LogsResponse {
  available: boolean;
  entries: Array<{ message: string; stream: string; level: string }>;
}

/** `fetch` with explicit headers; never follows redirects. */
function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return fetch(url, { redirect: "manual", ...init });
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Status and parsed error body, for compact assertions on refusals. */
async function outcome(response: Response): Promise<{ status: number; error?: string }> {
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: body.error };
}

/** Poll `GET /api/logs` until `probe` accepts its entries (capture files are tailed lazily). */
async function pollLogs<T>(
  baseUrl: string,
  probe: (entries: LogsResponse["entries"]) => T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: LogsResponse | undefined;
  for (;;) {
    const response = await request(`${baseUrl}/api/logs?limit=1000`);
    expect(response.status).toBe(200);
    last = (await response.json()) as LogsResponse;
    const value = probe(last.entries);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for /api/logs; last ${last.entries.length} entries:\n` +
          last.entries
            .slice(-20)
            .map((entry) => entry.message)
            .join("\n"),
      );
    }
    await Bun.sleep(100);
  }
}

const FORBIDDEN_HOST =
  "forbidden host; open the dashboard via http://localhost:<port> or http://127.0.0.1:<port>, " +
  "or add its origin to [dashboard].allowed_origins";

test.skipIf(!builtCli)(
  "the worker-embedded dashboard serves its API, runs an automation now, guards Host/Origin, and redacts logs",
  async () => {
    const port = await freePort();
    const allowedOrigin = "https://dash.e2e.example";
    const automation: WorkerAutomation = {
      id: AUTOMATION_ID,
      cron: NEVER_CRON,
      prompt: "Change the greeting to Hello, world! and run bun test.",
      // `--no-git`: the run implements in its worktree without branch/push.
      openPr: false,
    };
    const worker = new WorkerFixture({
      automations: [automation],
      dashboard: { port, allowedOrigins: [allowedOrigin], tailscaleAutodetect: false },
      env: {
        // Holds the manual run active long enough to observe the overlap rule.
        E2E_AGENT_DELAY_MS: "4000",
      },
    });
    const baseUrl = dashboardBaseUrl("127.0.0.1", port);
    const loopbackWrite = dashboardWriteHeaders(baseUrl);
    const runNowUrl = `${baseUrl}/api/automations/${AUTOMATION_ID}/run`;
    try {
      await worker.prepare();
      // A workspace `.env` is loaded into the daemon; its value must never be
      // echoed into the dashboard's log view.
      writeFileSync(
        join(worker.workspaceDir, ".env"),
        `E2E_DASHBOARD_API_TOKEN=${FAKE_API_TOKEN_VALUE}\n`,
      );
      worker.start();
      await worker.waitForReady();
      await waitForDashboardHealth(baseUrl, {
        assertAlive: () => {
          if (!worker.running) throw new Error(`worker exited\n${worker.tail()}`);
        },
        describe: () => worker.tail(),
      });
      await worker.waitFor("the automation schedule row", () =>
        worker.automationSchedules().some((row) => row.automation_id === AUTOMATION_ID)
          ? true
          : undefined,
      );
      const diagnostics = () =>
        [
          `runs: ${JSON.stringify(worker.automationRuns(AUTOMATION_ID))}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          worker.tail(),
        ].join("\n");

      // --- 1. embedded API --------------------------------------------------
      const health = await request(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const status = await jsonOf<{ worker: { status: string; pid?: number }; dbMissing: boolean }>(
        await request(`${baseUrl}/api/worker`),
      );
      expect(status.worker.status, diagnostics()).toBe("running");
      expect(status.worker.pid).toBe(worker.daemonPid() as number);
      expect(status.dbMissing).toBe(false);

      const listed = await request(`${baseUrl}/api/automations`);
      expect(listed.status).toBe(200);
      const { automations } = await jsonOf<{ automations: AutomationView[] }>(listed);
      const view = automations.find((item) => item.id === AUTOMATION_ID);
      expect(view, JSON.stringify(automations)).toMatchObject({
        id: AUTOMATION_ID,
        kind: "automation",
        enabled: true,
        schedule: NEVER_CRON,
        openPr: false,
      });
      // The next occurrence is the far-future cron boundary, not "now".
      expect(view?.nextDueAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
      expect(view?.lastRun).toBeUndefined();

      // --- 3a. Host/Origin guard: rejected writes create nothing ------------
      const rejected = [
        // Foreign Origin on a loopback Host (CSRF).
        await outcome(
          await request(runNowUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: EVIL_ORIGIN },
          }),
        ),
        // DNS rebinding: the attacker's name arrives as the Host, and the
        // page's own origin matches it, so only the Host check can refuse.
        await outcome(
          await request(runNowUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: `attacker.example:${port}`,
              Origin: `http://attacker.example:${port}`,
            },
          }),
        ),
        // An allowlisted origin cannot vouch for a foreign Host.
        await outcome(
          await request(runNowUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: `attacker.example:${port}`,
              Origin: allowedOrigin,
            },
          }),
        ),
        // Allowlisted Host with someone else's Origin.
        await outcome(
          await request(runNowUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: new URL(allowedOrigin).host,
              Origin: EVIL_ORIGIN,
            },
          }),
        ),
        // No Origin and no same-origin fetch metadata.
        await outcome(
          await request(runNowUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ];
      expect(rejected).toEqual([
        { status: 403, error: "forbidden: cross-origin request" },
        { status: 403, error: FORBIDDEN_HOST },
        { status: 403, error: FORBIDDEN_HOST },
        { status: 403, error: "forbidden: cross-origin request" },
        { status: 403, error: "forbidden: missing Origin header" },
      ]);
      // Correct Origin but a form-encodable content type (simple CORS request).
      const formPost = await request(runNowUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Origin: new URL(baseUrl).origin },
      });
      expect(await outcome(formPost)).toEqual({
        status: 415,
        error: "unsupported media type: expected application/json",
      });

      // Rebinding also cannot read: the Host check runs for GET.
      const reboundRead = await request(`${baseUrl}/api/runs`, {
        headers: { Host: `attacker.example:${port}` },
      });
      expect(await outcome(reboundRead)).toEqual({ status: 403, error: FORBIDDEN_HOST });

      // The allowlisted origin, arriving with its own Host, passes the guard:
      // reads work, and a write reaches the route (404 for an unknown id).
      const proxiedRead = await request(`${baseUrl}/api/automations`, {
        headers: { Host: new URL(allowedOrigin).host },
      });
      expect(proxiedRead.status).toBe(200);
      const proxiedWrite = await request(`${baseUrl}/api/automations/not-configured/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: new URL(allowedOrigin).host,
          Origin: allowedOrigin,
        },
      });
      expect(await outcome(proxiedWrite)).toEqual({
        status: 404,
        error: 'automation "not-configured" not found',
      });

      // Nothing above reached the scheduler.
      expect(worker.automationRuns(AUTOMATION_ID), diagnostics()).toEqual([]);
      expect(worker.agentInvocations(), diagnostics()).toEqual([]);
      expect(worker.automationOccurrences(AUTOMATION_ID)).toEqual([]);

      // --- 2. Run now -------------------------------------------------------
      const triggered = await request(runNowUrl, { method: "POST", headers: loopbackWrite });
      expect(triggered.status, diagnostics()).toBe(202);
      expect(await triggered.json()).toEqual({ status: "triggered", automationId: AUTOMATION_ID });

      // `triggerManual` registers the active run before it returns, and the
      // agent sleeps for E2E_AGENT_DELAY_MS, so this overlaps the first run.
      const second = await outcome(
        await request(runNowUrl, { method: "POST", headers: loopbackWrite }),
      );
      expect(second.status, diagnostics()).toBe(409);
      expect(
        second.error === `automation "${AUTOMATION_ID}" is already running` ||
          new RegExp(
            `^automation "${AUTOMATION_ID}" already has a run in progress \\(run \\d+\\); wait for it to finish$`,
          ).test(second.error ?? ""),
        `second run-now: ${JSON.stringify(second)}\n${diagnostics()}`,
      ).toBe(true);

      const active = await worker.waitFor(
        "the manual run row",
        () => worker.automationRuns(AUTOMATION_ID)[0],
      );
      expect(active.origin, diagnostics()).toBe("manual");
      expect(active.automation_id).toBe(AUTOMATION_ID);

      const run = await worker.waitForAutomationRun(AUTOMATION_ID, 60_000);
      expect(run.status, diagnostics()).toBe("succeeded");
      expect(run.origin).toBe("manual");
      // Exactly one run and one agent invocation: the refused trigger spawned nothing.
      expect(worker.automationRuns(AUTOMATION_ID), diagnostics()).toHaveLength(1);
      expect(worker.agentInvocations(), diagnostics()).toEqual([
        { mode: "implement", automation: AUTOMATION_ID },
      ]);

      const runs = await jsonOf<{ runs: RunView[]; total: number }>(
        await request(`${baseUrl}/api/runs?automationId=${AUTOMATION_ID}`),
      );
      expect(runs.total).toBe(1);
      expect(runs.runs[0]).toMatchObject({
        id: run.id,
        status: "succeeded",
        origin: "manual",
        automationId: AUTOMATION_ID,
      });
      const manualRuns = await jsonOf<{ runs: RunView[] }>(
        await request(`${baseUrl}/api/runs?origin=manual`),
      );
      expect(manualRuns.runs.map((item) => item.id)).toEqual([run.id]);

      const after = await jsonOf<{ automations: AutomationView[] }>(
        await request(`${baseUrl}/api/automations`),
      );
      expect(after.automations.find((item) => item.id === AUTOMATION_ID)?.lastRun).toMatchObject({
        id: run.id,
        origin: "manual",
        automationId: AUTOMATION_ID,
        status: "succeeded",
      });

      // --- 4. logs readback and redaction -----------------------------------
      const logs = await jsonOf<LogsResponse>(await request(`${baseUrl}/api/logs`));
      expect(logs.available).toBe(true);
      const messages = logs.entries.map((entry) => entry.message);
      expect(messages).toContainEqual(expect.stringContaining("Starting devintern worker"));
      expect(messages).toContainEqual(
        expect.stringContaining(`[automation:${AUTOMATION_ID}] starting manual run (dashboard)`),
      );

      // A rejected live reload echoes the offending value into the worker's
      // stderr capture (`[[automations]][N].repo "…" does not match any
      // [[repos]] name.`). Seed a token-shaped value and a `KEY=value`
      // credential assignment there; one write so both land in one reload.
      worker.appendAutomation({
        id: "e2e-leaky-token",
        cron: NEVER_CRON,
        prompt: "never runs",
        repo: FAKE_GITHUB_TOKEN,
      });
      worker.appendAutomation({
        id: "e2e-leaky-assignment",
        cron: NEVER_CRON,
        prompt: "never runs",
        repo: `E2E_API_TOKEN=${FAKE_API_TOKEN_VALUE}`,
      });
      await worker.waitFor("the rejected reload to echo both seeded values", () =>
        worker.logs.includes(FAKE_GITHUB_TOKEN) && worker.logs.includes(FAKE_API_TOKEN_VALUE)
          ? true
          : undefined,
      );
      // The raw daemon output (the fixture's own pipe) really carried both
      // values, so the dashboard below is redacting lines that contained them.
      expect(worker.logs).toContain("Failed to reload workspace config");

      const reloadErrors = await pollLogs(baseUrl, (entries) => {
        const matching = entries.filter((entry) =>
          entry.message.includes("does not match any [[repos]] name"),
        );
        return matching.length >= 2 ? matching : undefined;
      });
      expect(reloadErrors.map((entry) => entry.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('.repo "[redacted]" does not match any [[repos]] name.'),
          // `redactSecrets` masks a bare `KEY=value` up to the next whitespace,
          // so the closing quote is swallowed too (over-redaction, not a leak).
          expect.stringContaining(
            '.repo "E2E_API_TOKEN=[redacted] does not match any [[repos]] name.',
          ),
        ]),
      );
      expect(reloadErrors.every((entry) => entry.stream === "err")).toBe(true);
      const rawLogs = await (await request(`${baseUrl}/api/logs?limit=1000`)).text();
      expect(rawLogs).not.toContain(FAKE_GITHUB_TOKEN);
      expect(rawLogs).not.toContain(FAKE_API_TOKEN_VALUE);
      // URL-encoded forms must not slip through either.
      expect(rawLogs).not.toContain(encodeURIComponent(`E2E_API_TOKEN=${FAKE_API_TOKEN_VALUE}`));

      // The worker kept the previous config: the automation is still listed
      // and the rejected entries are not.
      const kept = await jsonOf<{ automations: AutomationView[] }>(
        await request(`${baseUrl}/api/automations`),
      );
      expect(kept.automations.map((item) => item.id)).toEqual([AUTOMATION_ID]);
      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  180_000,
);

test.skipIf(!builtCli)(
  "the standalone dashboard trusts only loopback plus --allow-origin and DASHBOARD_ALLOWED_ORIGINS",
  async () => {
    const worker = new WorkerFixture({ rootPrefix: "devintern-e2e-dashboard-guard-" });
    const flagOrigin = "https://flag.e2e.example";
    const envOrigin = "https://env.e2e.example:8443";
    let dashboard: DashboardFixture | undefined;
    try {
      // No daemon: `POST /api/tasks` only enqueues, so every accepted or
      // rejected write is visible as an injected-task row (or its absence).
      await worker.prepare();
      dashboard = await DashboardFixture.start(worker, {
        args: ["--allow-origin", flagOrigin, "--no-tailscale-autodetect"],
        env: { DASHBOARD_ALLOWED_ORIGINS: envOrigin, DASHBOARD_TAILSCALE_AUTODETECT: "0" },
      });
      const baseUrl = dashboard.baseUrl;
      const port = dashboard.port;
      const tasksUrl = `${baseUrl}/api/tasks`;
      const taskBody = (title: string) =>
        JSON.stringify({ repo: worker.repoName, title, body: "Guarded dashboard write." });

      // Plain loopback reads keep working, on both loopback names.
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
        const read = await request(`${baseUrl}/api/worker`, { headers: { Host: host } });
        expect(read.status, host).toBe(200);
      }

      const rejected = [
        await outcome(
          await request(tasksUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: EVIL_ORIGIN },
            body: taskBody("foreign origin"),
          }),
        ),
        await outcome(
          await request(tasksUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: `attacker.example:${port}`,
              Origin: `http://attacker.example:${port}`,
            },
            body: taskBody("rebound host"),
          }),
        ),
        // A flag-allowed origin on a loopback Host is accepted (proxies that
        // rewrite Host), but not with a foreign Host.
        await outcome(
          await request(tasksUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: "attacker.example",
              Origin: flagOrigin,
            },
            body: taskBody("allowed origin, foreign host"),
          }),
        ),
        // The env origin's Host includes its non-default port; without it the
        // Host is a different authority.
        await outcome(
          await request(tasksUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: "env.e2e.example",
              Origin: envOrigin,
            },
            body: taskBody("allowed origin, wrong port"),
          }),
        ),
        // Another loopback port's page is cross-origin too.
        await outcome(
          await request(tasksUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: `http://127.0.0.1:${port + 1}`,
            },
            body: taskBody("other loopback port"),
          }),
        ),
      ];
      expect(rejected).toEqual([
        { status: 403, error: "forbidden: cross-origin request" },
        { status: 403, error: FORBIDDEN_HOST },
        { status: 403, error: FORBIDDEN_HOST },
        { status: 403, error: FORBIDDEN_HOST },
        { status: 403, error: "forbidden: cross-origin request" },
      ]);
      const reboundRead = await request(`${baseUrl}/api/runs`, {
        headers: { Host: `attacker.example:${port}` },
      });
      expect(await outcome(reboundRead)).toEqual({ status: 403, error: FORBIDDEN_HOST });
      expect(worker.injectedRows()).toEqual([]);

      // Each allowlisted origin, with its matching Host, reads and writes.
      const accepted: Array<{ title: string; status: number }> = [];
      for (const origin of [flagOrigin, envOrigin]) {
        const host = new URL(origin).host;
        const read = await request(`${baseUrl}/api/health`, { headers: { Host: host } });
        expect(read.status, origin).toBe(200);
        const title = `accepted via ${origin}`;
        const write = await request(tasksUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Host: host, Origin: origin },
          body: taskBody(title),
        });
        accepted.push({ title, status: write.status });
      }
      // The loopback origin is accepted as well.
      const loopbackTitle = "accepted via loopback";
      const loopback = await request(tasksUrl, {
        method: "POST",
        headers: dashboardWriteHeaders(baseUrl),
        body: taskBody(loopbackTitle),
      });
      accepted.push({ title: loopbackTitle, status: loopback.status });
      expect(
        accepted.map((item) => item.status),
        dashboard.stderr,
      ).toEqual([201, 201, 201]);
      expect(worker.injectedRows().map((row) => [row.title, row.actor, row.status])).toEqual(
        accepted.map((item) => [item.title, "local:dashboard", "pending"]),
      );

      // Startup log names the explicit origins and never Tailscale ones.
      expect(dashboard.stdout).toContain(`Allowed origins: ${flagOrigin}, ${envOrigin}`);
      expect(dashboard.stdout).not.toContain("Tailscale Serve origins");

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  60_000,
);
