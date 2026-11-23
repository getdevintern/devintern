/**
 * Read-only worker commands (`devintern worker runs|stats|automations|prs|
 * queue|status|overview|logs`) against the worker-embedded dashboard.
 *
 * `worker --help` documents these as "no dashboard, worker, or network
 * needed; --json prints the matching /api response body". Production code:
 * `packages/code/src/lib/worker/dashboard-read-cli.ts` builds the same
 * `DashboardData` the dashboard server uses and calls its GET handlers
 * directly. This suite proves the two surfaces stay equal on a real worker
 * state database, and that the commands keep working once the worker stops.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { waitForDashboardHealth } from "../../helpers/dashboard";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { freePort } from "../../helpers/webhook-server";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import {
  cliAutomations,
  cliLogs,
  cliOverview,
  cliPrs,
  cliQueue,
  cliReadJson,
  cliRunDetail,
  cliRunList,
  cliStats,
  cliStatus,
  waitForSettledRun,
} from "../../helpers/worker-cli-state";

const builtCli = existsSync(cliPath);

// Midnight on January 1st: the automation is listed but never comes due, so
// `nextDueAt` is stable and no scheduled run races the parity checks.
const NEVER_CRON = "0 0 1 1 *";
const AUTOMATION_ID = "e2e-read-parity";

/**
 * Fields removed before comparing a CLI body with its route body, by route.
 *
 * Only inherently time-varying values belong here:
 * - `/api/overview` `generatedAt`: the wall-clock time the handler ran, so it
 *   differs between two calls by construction.
 *
 * Every other route is compared byte-for-byte (after JSON parsing). Values
 * that change while the idle worker keeps logging (log entries, log source
 * sizes) are handled by the stable-snapshot bracket in `expectParity`, not by
 * normalization.
 */
const TIME_VARYING_FIELDS: Record<string, string[]> = {
  "/api/overview": ["generatedAt"],
};

/**
 * Fields only the HTTP route returns, by route; the CLI must omit them.
 *
 * - `/api/worker` `serverPid`: pid of the process serving the dashboard. The
 *   CLI serves no dashboard, so it has no such pid. The route's value is
 *   asserted to be the daemon pid separately.
 */
const ROUTE_ONLY_FIELDS: Record<string, string[]> = {
  "/api/worker": ["serverPid"],
};

function normalize(route: string, body: unknown, surface: "route" | "cli"): unknown {
  const path = route.split("?")[0]!;
  const fields = TIME_VARYING_FIELDS[path] ?? [];
  const routeOnly = ROUTE_ONLY_FIELDS[path] ?? [];
  if (fields.length + routeOnly.length === 0 || typeof body !== "object" || body === null) {
    return body;
  }
  const copy = { ...(body as Record<string, unknown>) };
  for (const field of fields) {
    expect(copy).toHaveProperty(field);
    delete copy[field];
  }
  for (const field of routeOnly) {
    if (surface === "cli") {
      expect(copy).not.toHaveProperty(field);
    } else {
      expect(copy).toHaveProperty(field);
      delete copy[field];
    }
  }
  return copy;
}

async function getRoute(baseUrl: string, route: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${route}`);
  if (response.status !== 200) {
    throw new Error(`GET ${route} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Assert `worker <args> --json` equals `GET <route>` on the running worker.
 *
 * The route is read before and after the CLI call. When both reads agree the
 * state did not move in between, so the CLI body must equal it exactly; when
 * they differ (the idle worker appended a log line) the bracket is retried.
 */
async function expectParity(
  worker: WorkerFixture,
  baseUrl: string,
  args: string[],
  route: string,
): Promise<unknown> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = normalize(route, await getRoute(baseUrl, route), "route");
    const cli = normalize(route, await cliReadJson(worker, args), "cli");
    const after = normalize(route, await getRoute(baseUrl, route), "route");
    if (Bun.deepEquals(before, after, true)) {
      expect({ command: args.join(" "), body: cli }).toEqual({
        command: args.join(" "),
        body: before,
      });
      return cli;
    }
  }
  throw new Error(`GET ${route} never held still across a \`worker ${args.join(" ")}\` call`);
}

test.skipIf(!builtCli)(
  "read-only worker commands print their dashboard route's body, and still work once the worker stops",
  async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let proxy: RecordingProxy | undefined;
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-worker-read-",
      dashboard: { port, tailscaleAutodetect: false },
      automations: [
        { id: AUTOMATION_ID, cron: NEVER_CRON, prompt: "List the fixture files.", repo: "fixture" },
      ],
    });
    try {
      proxy = await startRecordingProxy();
      // Route the daemon's and every CLI call's HTTP(S) through a refusing
      // recorder: the read commands are documented as network-free.
      const proxyEnv = proxyEnvironment(proxy.url);
      Object.assign(worker.env, proxyEnv);
      await worker.prepare();

      const done = await worker.addTask({
        title: "Read command parity",
        body: "Change the greeting to Hello, world! and run bun test.",
      });
      // A dependent of a cancelled task is `blocked` and stays queued forever,
      // so `queue`/`status` have a pending item without a slow agent.
      const cancelled = await worker.addTask({
        title: "Cancelled dependency",
        body: "Never runs.",
      });
      const cancel = await worker.runCli(["worker", "cancel", cancelled.task_key]);
      expect(cancel.exitCode).toBe(0);
      const blocked = await worker.runAdd([
        "--repo",
        worker.repoName,
        "--title",
        "Blocked dependent",
        "--body",
        "Never runs.",
        "--after",
        cancelled.task_key,
        "--json",
      ]);
      expect(blocked.exitCode).toBe(0);
      const blockedKey = (JSON.parse(blocked.stdout.trim()) as { taskKey: string }).taskKey;

      worker.start();
      await worker.waitForReady();
      await waitForDashboardHealth(baseUrl, { describe: () => worker.tail() });
      const [run] = await waitForSettledRun(worker, done.task_key);
      expect(run?.status).toBe("succeeded");
      const runId = run!.id;

      const detail = await cliRunDetail(worker, runId);
      expect(detail.run.taskKey).toBe(done.task_key);
      expect(detail.harnessLogs.length).toBeGreaterThan(0);
      const harnessLog = detail.harnessLogs[0]!.name;

      // Each command with an /api counterpart, and the query parameter each
      // CLI flag maps to (`logs --lines` → `limit`, `runs --task-key` → `taskKey`).
      const pairs: Array<[string[], string]> = [
        [["runs"], "/api/runs"],
        [
          ["runs", "--task-key", done.task_key, "--limit", "5"],
          `/api/runs?taskKey=${done.task_key}&limit=5`,
        ],
        [["runs", "show", String(runId)], `/api/runs/${runId}`],
        [["runs", "logs", String(runId)], `/api/runs/${runId}/harness-logs`],
        [
          ["runs", "logs", String(runId), harnessLog],
          `/api/runs/${runId}/harness-logs/${encodeURIComponent(harnessLog)}`,
        ],
        [["runs", "artifacts", String(runId)], `/api/runs/${runId}/artifacts`],
        [["stats", "--window", "all"], "/api/stats?window=all"],
        [["stats", "--window", "7d"], "/api/stats?window=7d"],
        [["automations"], "/api/automations"],
        [["prs"], "/api/agent-prs"],
        [["prs", "--state", "merged"], "/api/agent-prs?state=merged"],
        [["queue"], "/api/queue"],
        [["status"], "/api/worker"],
        [["overview"], "/api/overview"],
        [["logs", "--lines", "20", "--level", "info"], "/api/logs?limit=20&level=info"],
        [["logs", "--lines", "5", "--level", "warn"], "/api/logs?limit=5&level=warn"],
      ];
      for (const [args, route] of pairs) {
        await expectParity(worker, baseUrl, args, route);
      }

      // Content sanity on top of parity, so equal-but-empty bodies cannot pass.
      const live = await cliStatus(worker);
      expect(live.worker.status).toBe("running");
      expect(live.worker.pid).toBe(worker.daemonPid());
      // The route reports the daemon as its server; `worker doctor` relies on it.
      expect(((await getRoute(baseUrl, "/api/worker")) as { serverPid?: number }).serverPid).toBe(
        worker.daemonPid(),
      );
      expect(live.queue.injected.pending).toBe(1);
      expect((await cliOverview(worker)).worker.status).toBe("running");
      const stats = await cliStats(worker, "all");
      expect(stats.stats?.totals.byStatus.succeeded).toBe(1);
      expect(stats.stats?.byOrigin.local).toBe(1);
      expect((await cliAutomations(worker)).map((automation) => automation.id)).toEqual([
        AUTOMATION_ID,
      ]);
      const logs = await cliLogs(worker, 50, "info");
      expect(logs.available).toBe(true);
      expect(
        logs.entries.some((entry) => entry.message.includes("Starting devintern worker")),
      ).toBe(true);

      // An invalid --window fails the same way on both surfaces.
      const badWindow = await worker.runCli(["worker", "stats", "--window", "1y", "--json"]);
      expect(badWindow.exitCode).toBe(1);
      expect(badWindow.stdout).toBe("");
      expect(badWindow.stderr).toContain("window must be one of: 7d, 30d, 90d, all");
      const badWindowApi = await fetch(`${baseUrl}/api/stats?window=1y`);
      expect(badWindowApi.status).toBe(400);
      expect(((await badWindowApi.json()) as { error: string }).error).toBe(
        "window must be one of: 7d, 30d, 90d, all",
      );

      await worker.stop();

      // From the state database alone: no worker, no dashboard.
      const dashboardGone = await fetch(`${baseUrl}/api/health`).then(
        () => false,
        () => true,
      );
      expect(dashboardGone).toBe(true);
      const stopped = await cliStatus(worker);
      expect(stopped.worker.status).toBe("stopped");
      expect(stopped.dbMissing).toBe(false);
      expect(stopped.queue.injected).toEqual({ pending: 1, running: 0 });
      expect((await cliOverview(worker)).worker.status).toBe("stopped");
      const history = await cliRunList(worker);
      expect(history.total).toBe(1);
      expect(history.runs.map((entry) => [entry.id, entry.taskKey, entry.status])).toEqual([
        [runId, done.task_key, "succeeded"],
      ]);
      const stoppedDetail = await cliRunDetail(worker, runId);
      expect(stoppedDetail.stages.map((stage) => stage.stage)).toContain("implementation");
      expect((await cliStats(worker, "all")).stats?.totals.runs).toBe(1);
      expect((await cliAutomations(worker)).map((automation) => automation.id)).toEqual([
        AUTOMATION_ID,
      ]);
      expect((await cliPrs(worker)).prs).toEqual([]);
      expect((await cliPrs(worker, "merged")).prs).toEqual([]);
      const queue = await cliQueue(worker);
      expect(queue.items.map((item) => [item.taskKey, item.dependencyState])).toEqual([
        [blockedKey, "blocked"],
      ]);
      expect(queue.cancelled.map((item) => item.taskKey)).toEqual([cancelled.task_key]);
      const stoppedLogs = await cliLogs(worker, 500);
      expect(stoppedLogs.available).toBe(true);
      expect(stoppedLogs.entries.length).toBeGreaterThan(0);
      for (const args of [
        ["runs", "logs", String(runId)],
        ["runs", "artifacts", String(runId)],
      ]) {
        expect(await cliReadJson(worker, args)).toBeObject();
      }

      // Human (non-JSON) output: exit 0 and something printed, for each command.
      const human: string[][] = [
        ["runs"],
        ["runs", "show", String(runId)],
        ["runs", "logs", String(runId)],
        ["runs", "logs", String(runId), harnessLog],
        ["runs", "artifacts", String(runId)],
        ["stats", "--window", "all"],
        ["automations"],
        ["prs"],
        ["prs", "--state", "merged"],
        ["queue"],
        ["status"],
        ["overview"],
        ["logs", "--lines", "10"],
      ];
      for (const args of human) {
        const result = await worker.runCli(["worker", ...args]);
        expect({ args, exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          args,
          exitCode: 0,
          stderr: "",
        });
        expect(result.stdout.trim().length).toBeGreaterThan(0);
      }
      const statusText = await worker.runCli(["worker", "status"]);
      expect(statusText.stdout).toContain("Worker:     stopped");
      const queueText = await worker.runCli(["worker", "queue"]);
      expect(queueText.stdout).toContain(`blocked: ${cancelled.task_key} was cancelled`);

      // Error paths: a bad --workspace on every command, an unknown run, bad flags.
      const missingWorkspace = join(worker.root, "no-such-workspace");
      for (const command of [
        "runs",
        "stats",
        "automations",
        "prs",
        "queue",
        "status",
        "overview",
        "logs",
      ]) {
        const result = await worker.runCli([
          "worker",
          command,
          "--workspace",
          missingWorkspace,
          "--json",
        ]);
        expect({ command, exitCode: result.exitCode, stdout: result.stdout }).toEqual({
          command,
          exitCode: 1,
          stdout: "",
        });
        expect(result.stderr).toContain(`No workspace.toml at ${missingWorkspace}`);
      }
      const stoppedBadWindow = await worker.runCli(["worker", "stats", "--window", "1y"]);
      expect(stoppedBadWindow.exitCode).toBe(1);
      expect(stoppedBadWindow.stderr).toContain("window must be one of: 7d, 30d, 90d, all");
      const badLevel = await worker.runCli(["worker", "logs", "--level", "debug", "--json"]);
      expect(badLevel.exitCode).toBe(1);
      expect(badLevel.stderr).toContain("level must be one of: all, info, warn, error");
      const unknownRun = await worker.runCli(["worker", "runs", "show", "999999", "--json"]);
      expect(unknownRun.exitCode).toBe(1);
      expect(unknownRun.stdout).toBe("");
      expect(unknownRun.stderr).toContain("run 999999 not found");

      expect(proxy.requests()).toEqual([]);
    } finally {
      try {
        await worker.dispose();
      } finally {
        await proxy?.close();
      }
    }
  },
  180_000,
);
