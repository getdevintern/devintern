/**
 * `devintern worker doctor` tracker checks for Linear, Trello, and Azure
 * DevOps against the in-process fakes: the **Tracker credentials** row
 * (`trackerRequiredEnv` plus the credential probe) and the **Task query** dry
 * run (`createTrackerClient(...).searchTasks`) in `collectConfigScopedChecks`
 * (`packages/code/src/lib/observability/worker-readiness.ts`). The Jira
 * counterpart is `worker-doctor-trackers.test.ts`.
 *
 * Each fake is started with a caller-chosen random secret and answers any
 * other credential with the provider's 401, so a wrong token cannot pass.
 * Secrets live only in the workspace `.env` or `[teams.env]`; a recording
 * proxy catches any request that tries to leave the machine.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAzureDevOpsTracker } from "../../providers/fake-azure-devops";
import { FakeLinearTracker } from "../../providers/fake-linear";
import { FakeTrelloTracker } from "../../providers/fake-trello";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import { doctorWithout, dotenv, expectLines, randomToken } from "../../helpers/worker-doctor";

const builtCli = existsSync(cliPath);
const NOT_READY = "❌ Not ready — the worker would sit idle or fail. Fix the checks above.";
const DEFAULTS_HINT =
  "💡 Fix [defaults].task_query in workspace.toml (renamed status, project, or field?)";

/** Start a recording proxy and a worker fixture, run `body`, always clean up. */
async function withDoctorWorker(
  options: { prefix: string; tracker: string; taskQuery?: string },
  fakes: Array<{ cleanup(): Promise<void> }>,
  body: (worker: WorkerFixture, proxy: RecordingProxy) => Promise<void>,
): Promise<void> {
  let proxy: RecordingProxy | undefined;
  const worker = new WorkerFixture({
    rootPrefix: options.prefix,
    tracker: options.tracker,
    ...(options.taskQuery
      ? { workspaceTomlExtra: `task_query = ${JSON.stringify(options.taskQuery)}` }
      : {}),
  });
  try {
    proxy = await startRecordingProxy();
    Object.assign(worker.env, proxyEnvironment(proxy.url));
    await worker.prepare();
    await body(worker, proxy);
    expect(existsSync(worker.dbPath)).toBe(false);
    expect(existsSync(worker.lockFile)).toBe(false);
    expect(proxy.requests()).toEqual([]);
  } finally {
    try {
      await worker.dispose();
    } finally {
      try {
        await Promise.allSettled(fakes.map((fake) => fake.cleanup()));
      } finally {
        await proxy?.close();
      }
    }
  }
}

test.skipIf(!builtCli)(
  "worker doctor dry-runs a Linear [defaults].task_query and fails on a rejected filter, a wrong key, or a missing key",
  async () => {
    const apiKey = randomToken("lin_api_e2e");
    const wrongKey = randomToken("lin_api_wrong");
    const marker = randomToken("E2ELINEAR");
    const filter = { title: { containsIgnoreCase: marker } };
    const tracker = new FakeLinearTracker({ apiKey });
    const label = "linear ([defaults])";
    await withDoctorWorker(
      {
        prefix: "devintern-e2e-doctor-linear-",
        tracker: "linear",
        taskQuery: JSON.stringify(filter),
      },
      [tracker],
      async (worker) => {
        const envPath = join(worker.workspaceDir, ".env");
        const { LINEAR_API_URL } = tracker.environment();
        const writeEnv = (values: Record<string, string>) =>
          writeFileSync(envPath, dotenv({ LINEAR_API_URL: LINEAR_API_URL!, ...values }), {
            mode: 0o600,
          });
        writeEnv({ LINEAR_API_KEY: apiKey });
        await tracker.createTicket({ title: `Ready one ${marker}`, body: "First." });
        await tracker.createTicket({ title: `Ready two ${marker}`, body: "Second." });
        await tracker.createTicket({ title: "Decoy", body: "Outside the filter." });
        const doctor = () => doctorWithout(worker, [apiKey, wrongKey]);
        const filters = () => tracker.searchRequests.map((request) => request.filter);

        const ready = await doctor();
        expect(ready.exitCode, ready.stdout).toBe(0);
        expectLines(ready, [
          `✅ Tracker credentials — ${label}`,
          `✅ Task query — ${label}: 2 tasks match`,
          "✅ Everything looks good — start the worker with `devintern worker`.",
        ]);
        expect(filters()).toEqual([filter]);

        // Linear rejects the filter: HTTP 400 with GraphQL `errors`.
        const invalid = `Variable "$filter" got invalid value; Field "${marker}" is not defined`;
        tracker.rejectSearchFiltersContaining(marker, invalid);
        const rejected = await doctor();
        expect(rejected.exitCode, rejected.stdout).toBe(1);
        expectLines(rejected, [
          `✅ Tracker credentials — ${label}`,
          `❌ Task query — ${label}: Linear API error (400): `,
          invalid.replaceAll('"', '\\"'),
          DEFAULTS_HINT,
          NOT_READY,
        ]);
        expect(filters()).toEqual([filter, filter]);

        // A key the fake does not know: the probe gets Linear's 401, no search runs.
        writeEnv({ LINEAR_API_KEY: wrongKey });
        const wrong = await doctor();
        expect(wrong.exitCode, wrong.stdout).toBe(1);
        expectLines(wrong, [
          `❌ Tracker credentials — ${label}: Linear API error (401): `,
          "Authentication required, not authenticated",
          // The "(missing tracker credentials)" suffix is not asserted here: nothing is missing.
          `❌ Task query — ${label}: not run`,
        ]);
        expect(tracker.unauthorizedRequests).toBe(1);
        expect(filters()).toEqual([filter, filter]);

        // LINEAR_API_KEY absent: named in the row, and no request at all.
        writeEnv({});
        const operations = tracker.operations.length;
        const missing = await doctor();
        expect(missing.exitCode, missing.stdout).toBe(1);
        expectLines(missing, [
          `❌ Tracker credentials — ${label}: missing LINEAR_API_KEY`,
          `💡 Add the missing variables to ${envPath}`,
          `❌ Task query — ${label}: not run (missing tracker credentials)`,
          NOT_READY,
        ]);
        expect(tracker.operations.length).toBe(operations);
        expect(tracker.unauthorizedRequests).toBe(1);
        expect(tracker.unexpectedOperations).toEqual([]);
      },
    );
  },
  120_000,
);

test.skipIf(!builtCli)(
  "worker doctor dry-runs a Trello [defaults].task_query and fails on a rejected search, a wrong token, or a missing token",
  async () => {
    const apiKey = randomToken("e2etrellokey");
    const apiToken = randomToken("e2etrellotoken");
    const wrongToken = randomToken("e2etrellowrong");
    const marker = randomToken("e2etrello");
    const query = `is:open ${marker}`;
    const tracker = new FakeTrelloTracker({ apiKey, apiToken });
    const label = "trello ([defaults])";
    await withDoctorWorker(
      { prefix: "devintern-e2e-doctor-trello-", tracker: "trello", taskQuery: query },
      [tracker],
      async (worker) => {
        const envPath = join(worker.workspaceDir, ".env");
        const { TRELLO_API_BASE_URL, TRELLO_DEFAULT_BOARD_ID } = tracker.environment();
        const writeEnv = (values: Record<string, string>) =>
          writeFileSync(
            envPath,
            dotenv({
              TRELLO_API_BASE_URL: TRELLO_API_BASE_URL!,
              TRELLO_DEFAULT_BOARD_ID: TRELLO_DEFAULT_BOARD_ID!,
              TRELLO_API_KEY: apiKey,
              ...values,
            }),
            { mode: 0o600 },
          );
        writeEnv({ TRELLO_API_TOKEN: apiToken });
        await tracker.createTicket({ title: "Ready one", body: `First.\n\n${marker}\n` });
        await tracker.createTicket({ title: "Ready two", body: `Second.\n\n${marker}\n` });
        await tracker.createTicket({ title: "Decoy", body: "Outside the query." });
        const doctor = () => doctorWithout(worker, [apiKey, apiToken, wrongToken]);

        const ready = await doctor();
        expect(ready.exitCode, ready.stdout).toBe(0);
        expectLines(ready, [
          `✅ Tracker credentials — ${label}`,
          `✅ Task query — ${label}: 2 tasks match`,
          "✅ Everything looks good — start the worker with `devintern worker`.",
        ]);
        expect(tracker.searches).toEqual([query]);

        // Trello rejects the search: HTTP 400 with a plain-text body.
        tracker.rejectSearchesContaining(marker, "invalid value for query");
        const rejected = await doctor();
        expect(rejected.exitCode, rejected.stdout).toBe(1);
        expectLines(rejected, [
          `✅ Tracker credentials — ${label}`,
          `❌ Task query — ${label}: Trello API error (400): invalid value for query`,
          DEFAULTS_HINT,
          NOT_READY,
        ]);
        expect(tracker.searches).toEqual([query, query]);

        // A token the fake does not know: the probe gets Trello's 401.
        writeEnv({ TRELLO_API_TOKEN: wrongToken });
        const wrong = await doctor();
        expect(wrong.exitCode, wrong.stdout).toBe(1);
        expectLines(wrong, [
          `❌ Tracker credentials — ${label}: Trello API error (401): invalid token`,
          `❌ Task query — ${label}: not run`,
        ]);
        expect(tracker.searches).toEqual([query, query]);

        // TRELLO_API_TOKEN absent: named in the row, and no request at all.
        writeEnv({});
        const requests = tracker.requests.length;
        const missing = await doctor();
        expect(missing.exitCode, missing.stdout).toBe(1);
        expectLines(missing, [
          `❌ Tracker credentials — ${label}: missing TRELLO_API_TOKEN`,
          `💡 Add the missing variables to ${envPath}`,
          `❌ Task query — ${label}: not run (missing tracker credentials)`,
          NOT_READY,
        ]);
        expect(tracker.requests.length).toBe(requests);
        expect(tracker.unexpectedRequests).toEqual([]);
      },
    );
  },
  120_000,
);

test.skipIf(!builtCli)(
  "worker doctor checks a Trello [[teams]] source with its [teams.env] credentials and team-scoped hints",
  async () => {
    const apiKey = randomToken("e2etrellokey");
    const apiToken = randomToken("e2etrellotoken");
    const marker = randomToken("e2etrelloteam");
    const query = `is:open ${marker}`;
    const tracker = new FakeTrelloTracker({ apiKey, apiToken });
    const label = 'trello (team "ops")';
    await withDoctorWorker(
      { prefix: "devintern-e2e-doctor-trello-team-", tracker: "trello" },
      [tracker],
      async (worker) => {
        const configPath = join(worker.workspaceDir, "workspace.toml");
        const { TRELLO_API_BASE_URL, TRELLO_DEFAULT_BOARD_ID } = tracker.environment();
        // Only the non-secret endpoint lives in the shared workspace .env.
        writeFileSync(
          join(worker.workspaceDir, ".env"),
          dotenv({ TRELLO_API_BASE_URL: TRELLO_API_BASE_URL! }),
          { mode: 0o600 },
        );
        const base = readFileSync(configPath, "utf8");
        const writeTeam = (teamEnv: Record<string, string>) =>
          writeFileSync(
            configPath,
            [
              base,
              "[[teams]]",
              'name = "ops"',
              'tracker = "trello"',
              `task_query = ${JSON.stringify(query)}`,
              "  [teams.env]",
              ...Object.entries({
                TRELLO_DEFAULT_BOARD_ID: TRELLO_DEFAULT_BOARD_ID!,
                ...teamEnv,
              }).map(([key, value]) => `  ${key} = ${JSON.stringify(value)}`),
              "",
            ].join("\n"),
          );
        writeTeam({ TRELLO_API_KEY: apiKey, TRELLO_API_TOKEN: apiToken });
        await tracker.createTicket({ title: "Ops ready", body: `Ops.\n\n${marker}\n` });
        const doctor = () => doctorWithout(worker, [apiKey, apiToken]);

        const ready = await doctor();
        expect(ready.exitCode, ready.stdout).toBe(0);
        expectLines(ready, [
          `✅ Workspace config — 1 repo, 1 team, 0 automations (${configPath})`,
          `✅ Tracker credentials — ${label}`,
          `✅ Task query — ${label}: 1 task matches`,
        ]);
        expect(tracker.searches).toEqual([query]);

        tracker.rejectSearchesContaining(marker, "invalid value for query");
        const rejected = await doctor();
        expect(rejected.exitCode, rejected.stdout).toBe(1);
        expectLines(rejected, [
          `❌ Task query — ${label}: Trello API error (400): invalid value for query`,
          '💡 Fix task_query for [[teams]] "ops" in workspace.toml (renamed status, project, or field?)',
          NOT_READY,
        ]);
        expect(tracker.searches).toEqual([query, query]);

        writeTeam({ TRELLO_API_KEY: apiKey });
        const requests = tracker.requests.length;
        const missing = await doctor();
        expect(missing.exitCode, missing.stdout).toBe(1);
        expectLines(missing, [
          `❌ Tracker credentials — ${label}: missing TRELLO_API_TOKEN`,
          '💡 Add the missing variables to the workspace .env, a team env_file, or [teams.env] for "ops"',
          `❌ Task query — ${label}: not run (missing tracker credentials)`,
          NOT_READY,
        ]);
        expect(tracker.requests.length).toBe(requests);
        expect(tracker.unexpectedRequests).toEqual([]);
      },
    );
  },
  120_000,
);

test.skipIf(!builtCli)(
  "worker doctor reports a missing Azure DevOps PAT without any request and never prints the PAT",
  async () => {
    const pat = randomToken("e2eazurepat");
    // Azure DevOps sends the PAT as Basic auth with an empty user name.
    const basicPat = Buffer.from(`:${pat}`).toString("base64");
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS '${randomToken("E2EADO")}'`;
    const tracker = new FakeAzureDevOpsTracker({ pat });
    const label = "azure-devops ([defaults])";
    await withDoctorWorker(
      { prefix: "devintern-e2e-doctor-azure-devops-", tracker: "azure-devops", taskQuery: wiql },
      [tracker],
      async (worker) => {
        const {
          DEVINTERN_E2E_FAKE_AZURE_DEVOPS,
          TASK_TRACKER: _tracker,
          ...credentials
        } = tracker.environment();
        // The fake-endpoint opt-in is read before the workspace .env loads.
        worker.env.DEVINTERN_E2E_FAKE_AZURE_DEVOPS = DEVINTERN_E2E_FAKE_AZURE_DEVOPS!;
        const envPath = join(worker.workspaceDir, ".env");
        const doctor = (args: string[] = []) => doctorWithout(worker, [pat, basicPat], args);

        // --offline: the credential row is checked locally, the dry run is skipped.
        writeFileSync(envPath, dotenv(credentials), { mode: 0o600 });
        const offline = await doctor(["--offline"]);
        expect(offline.exitCode, offline.stdout).toBe(0);
        expectLines(offline, [
          `✅ Tracker credentials — ${label}`,
          `⚠️  Task query — ${label}: skipped (--offline)`,
        ]);

        // AZURE_DEVOPS_PAT absent: named in the row, and no request at all.
        const { AZURE_DEVOPS_PAT: _dropped, ...withoutPat } = credentials;
        writeFileSync(envPath, dotenv(withoutPat), { mode: 0o600 });
        const missing = await doctor();
        expect(missing.exitCode, missing.stdout).toBe(1);
        expectLines(missing, [
          `❌ Tracker credentials — ${label}: missing AZURE_DEVOPS_PAT`,
          `💡 Add the missing variables to ${envPath}`,
          `❌ Task query — ${label}: not run (missing tracker credentials)`,
          NOT_READY,
        ]);
        expect(tracker.wiqlRequests).toEqual([]);
        expect(tracker.unexpectedRequests).toEqual([]);
      },
    );
  },
  120_000,
);
