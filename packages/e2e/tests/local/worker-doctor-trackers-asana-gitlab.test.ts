/**
 * `devintern worker doctor` tracker checks for Asana and GitLab Issues against
 * the in-process fakes: the **Tracker credentials** row (`trackerRequiredEnv`
 * plus the credential probe in `defaultProbe`) and the **Task query** dry run
 * (`createTrackerClient(...).searchTasks`) in `collectConfigScopedChecks`
 * (`packages/code/src/lib/observability/worker-readiness.ts`). Jira is in
 * `worker-doctor-trackers.test.ts`; Linear, Trello, and Azure DevOps are in
 * `worker-doctor-trackers-more.test.ts`.
 *
 * Each fake requires one random token and answers any other with the
 * provider's 401, so a passing check proves doctor sent the configured secret.
 * Secrets live only in the workspace `.env`; a recording proxy catches any
 * request that tries to leave the machine.
 */

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAsanaTracker } from "../../providers/fake-asana";
import { FakeGitLabIssues } from "../../providers/fake-gitlab-issues";
import { cliPath } from "../../helpers/worker";
import {
  NOT_READY,
  READY,
  doctorWithout,
  dotenv,
  expectLines,
  randomToken,
  withDoctorWorker,
} from "../../helpers/worker-doctor";

const builtCli = existsSync(cliPath);

test.skipIf(!builtCli)(
  "worker doctor dry-runs an Asana project [defaults].task_query and fails on a wrong or missing token",
  async () => {
    const apiToken = randomToken("e2easanapat");
    const wrongToken = randomToken("e2easanawrong");
    const marker = randomToken("E2EASANADOCTOR");
    const tracker = new FakeAsanaTracker({ apiToken });
    const query = `project:${tracker.projectGidValue} ${marker}`;
    const label = "asana ([defaults])";
    await withDoctorWorker(
      { prefix: "devintern-e2e-doctor-asana-", tracker: "asana", taskQuery: query },
      [tracker],
      async (worker) => {
        const {
          DEVINTERN_E2E_FAKE_ASANA,
          ASANA_API_BASE_URL,
          ASANA_DEFAULT_PROJECT_GID,
          ASANA_API_TOKEN: environmentToken,
        } = tracker.environment();
        expect(environmentToken).toBe(apiToken);
        // The Asana client snapshots the fake opt-in and base URL at import,
        // before the workspace .env loads, so both go in the child environment.
        worker.env.DEVINTERN_E2E_FAKE_ASANA = DEVINTERN_E2E_FAKE_ASANA!;
        worker.env.ASANA_API_BASE_URL = ASANA_API_BASE_URL!;
        const envPath = join(worker.workspaceDir, ".env");
        const writeEnv = (values: Record<string, string>) =>
          writeFileSync(
            envPath,
            dotenv({ ASANA_DEFAULT_PROJECT_GID: ASANA_DEFAULT_PROJECT_GID!, ...values }),
            { mode: 0o600 },
          );
        const doctor = () => doctorWithout(worker, [apiToken, wrongToken]);

        await tracker.createTicket({ title: `Ready one ${marker}`, body: "First." });
        await tracker.createTicket({ title: `Ready two ${marker}`, body: "Second." });
        await tracker.createTicket({ title: "Decoy", body: "Outside the query." });

        // The credential probe (GET /projects) and the dry run both reach the fake.
        writeEnv({ ASANA_API_TOKEN: apiToken });
        const ready = await doctor();
        expect(ready.exitCode, ready.stdout).toBe(0);
        expectLines(ready, [
          `✅ Tracker credentials — ${label}`,
          `✅ Task query — ${label}: 2 tasks match`,
          READY,
        ]);
        expect(tracker.projectListRequests).toBe(1);
        expect(tracker.projectTaskListings).toEqual([tracker.projectGidValue]);
        expect(tracker.unauthorizedRequests).toBe(0);

        // A token the fake does not know: the probe gets Asana's 401, no listing runs.
        writeEnv({ ASANA_API_TOKEN: wrongToken });
        const wrong = await doctor();
        expect(wrong.exitCode, wrong.stdout).toBe(1);
        expectLines(wrong, [
          `❌ Tracker credentials — ${label}: Asana API error (401): `,
          "Not Authorized",
          `❌ Task query — ${label}: not run`,
          NOT_READY,
        ]);
        expect(tracker.unauthorizedRequests).toBe(1);
        expect(tracker.projectListRequests).toBe(1);
        expect(tracker.projectTaskListings).toEqual([tracker.projectGidValue]);

        // ASANA_API_TOKEN absent: named in the row, and no request at all.
        writeEnv({});
        const requests = tracker.requests.length;
        const missing = await doctor();
        expect(missing.exitCode, missing.stdout).toBe(1);
        expectLines(missing, [
          `❌ Tracker credentials — ${label}: missing ASANA_API_TOKEN`,
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
  "worker doctor dry-runs a GitLab Issues label [defaults].task_query and fails on a wrong token or an unknown project",
  async () => {
    const marker = randomToken("e2e-doctor-");
    const query = `is:open label:${marker}`;
    const tracker = new FakeGitLabIssues({ labels: [marker] });
    const wrongToken = randomToken("glpat-wrong-");
    const label = "gitlab ([defaults])";
    await withDoctorWorker(
      { prefix: "devintern-e2e-doctor-gitlab-", tracker: "gitlab", taskQuery: query },
      [tracker],
      async (worker) => {
        const { TASK_TRACKER: _tracker, GITLAB_TOKEN: token, ...settings } = tracker.environment();
        const envPath = join(worker.workspaceDir, ".env");
        const writeEnv = (values: Record<string, string>) =>
          writeFileSync(envPath, dotenv({ ...settings, ...values }), { mode: 0o600 });
        const doctor = () => doctorWithout(worker, [token!, wrongToken]);
        const searches = () => tracker.searchRequests().length;
        const userProbes = () =>
          tracker.requests().filter((request) => request.path === "/api/v4/user");

        tracker.createIssue({ title: "Ready one", description: "First.", labels: [marker] });
        tracker.createIssue({ title: "Ready two", description: "Second.", labels: [marker] });
        tracker.createIssue({ title: "Closed", description: "Done.", labels: [marker] });
        tracker.closeIssue(3);
        tracker.createIssue({ title: "Decoy", description: "Outside the query." });

        // The /user probe and the issue-list dry run both reach the fake.
        writeEnv({ GITLAB_TOKEN: token! });
        const ready = await doctor();
        expect(ready.exitCode, ready.stdout).toBe(0);
        expectLines(ready, [
          `✅ Tracker credentials — ${label}`,
          `✅ Task query — ${label}: 2 tasks match`,
          READY,
        ]);
        expect(userProbes().map((request) => request.status)).toEqual([200]);
        expect(searches()).toBe(1);

        // A token the fake does not know: the probe gets GitLab's 401, no search runs.
        writeEnv({ GITLAB_TOKEN: wrongToken });
        const wrong = await doctor();
        expect(wrong.exitCode, wrong.stdout).toBe(1);
        expectLines(wrong, [
          `❌ Tracker credentials — ${label}: GitLab API error (401): `,
          "401 Unauthorized",
          `❌ Task query — ${label}: not run`,
          NOT_READY,
        ]);
        expect(userProbes().map((request) => request.status)).toEqual([200, 401]);
        expect(searches()).toBe(1);
        expect(tracker.unexpectedRequests).toEqual([]);

        // A project the token cannot see: /user passes, the dry run gets GitLab's 404.
        const unknownProject = `e2e-group/${randomToken("missing-")}`;
        writeEnv({ GITLAB_TOKEN: token!, GITLAB_PROJECT: unknownProject });
        const unknown = await doctor();
        expect(unknown.exitCode, unknown.stdout).toBe(1);
        expectLines(unknown, [
          `✅ Tracker credentials — ${label}`,
          `❌ Task query — ${label}: GitLab API error (404): `,
          "404 Project Not Found",
          // The hint under this line (`Fix [defaults].task_query in workspace.toml`) is not
          // asserted: the bad value is GITLAB_PROJECT in .env (see the area file).
          NOT_READY,
        ]);
        expect(userProbes().map((request) => request.status)).toEqual([200, 401, 200]);
        expect(searches()).toBe(1);
        expect(
          tracker.unexpectedRequests.map(({ method, path, status }) => ({ method, path, status })),
        ).toEqual([
          {
            method: "GET",
            path: `/api/v4/projects/${encodeURIComponent(unknownProject)}/issues`,
            status: 404,
          },
        ]);
      },
    );
  },
  120_000,
);
