/**
 * `devintern worker doctor` tracker checks against the in-process fake Jira:
 * the **Tracker credentials** row (`trackerRequiredEnv`) and the **Task query**
 * dry run (`createTrackerClient(...).searchTasks`) for `[defaults].task_query`
 * and for `[[teams]]` sources, plus what `--offline` does to both
 * (`packages/code/src/lib/observability/worker-readiness.ts`
 * `collectConfigScopedChecks`).
 *
 * Credentials live only in the workspace `.env`, a team `env_file`, or
 * `[teams.env]`; the isolated child environment carries none. Each token is a
 * random fake value that must never appear in output.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeJiraTracker } from "../../providers/fake-jira";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAddResult } from "../../helpers/worker";

const builtCli = existsSync(cliPath);
const NOT_READY = "❌ Not ready — the worker would sit idle or fail. Fix the checks above.";
const UNKNOWN_STATUS = "The value 'Ready for Dev' does not exist for the field 'status'.";

const randomToken = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;

/** Jira credentials for one fake, with a caller-chosen secret token. */
function jiraEnv(tracker: FakeJiraTracker, token: string): Record<string, string> {
  const { JIRA_BASE_URL, JIRA_EMAIL } = tracker.environment();
  return { JIRA_BASE_URL: JIRA_BASE_URL!, JIRA_EMAIL: JIRA_EMAIL!, JIRA_API_TOKEN: token };
}

function dotenv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}

/** Run doctor and assert no secret (raw or URL-encoded) reached stdout or stderr. */
async function doctorWithout(
  worker: WorkerFixture,
  secrets: string[],
  args: string[] = [],
): Promise<WorkerAddResult> {
  const result = await worker.runCli(["worker", "doctor", ...args]);
  for (const output of [result.stdout, result.stderr]) {
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(encodeURIComponent(secret));
    }
  }
  return result;
}

function expectLines(result: WorkerAddResult, lines: string[]): void {
  for (const line of lines) expect(result.stdout).toContain(line);
}

test.skipIf(!builtCli)(
  "worker doctor dry-runs [defaults].task_query on fake Jira and fails on a rejected query or a missing credential",
  async () => {
    const marker = randomToken("E2EDOCTOR");
    const query = `text ~ "${marker}"`;
    const token = randomToken("e2e-jira-doctor-");
    const tracker = new FakeJiraTracker();
    let proxy: RecordingProxy | undefined;
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-worker-doctor-trackers-",
      tracker: "jira",
      workspaceTomlExtra: `task_query = ${JSON.stringify(query)}`,
    });
    try {
      proxy = await startRecordingProxy();
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      await worker.prepare();
      const configPath = join(worker.workspaceDir, "workspace.toml");
      const envPath = join(worker.workspaceDir, ".env");
      const credentials = jiraEnv(tracker, token);
      writeFileSync(envPath, dotenv(credentials), { mode: 0o600 });
      await tracker.createTicket({ title: "Ready one", body: `First.\n\n${marker}\n` });
      await tracker.createTicket({ title: "Ready two", body: `Second.\n\n${marker}\n` });
      await tracker.createTicket({ title: "Decoy", body: "Outside the query." });
      const doctor = (args: string[] = []) => doctorWithout(worker, [token], args);

      // (a) Credentials present and a valid JQL: one dry-run search, exact JQL.
      const ready = await doctor();
      expect(ready.exitCode, ready.stdout).toBe(0);
      expectLines(ready, [
        "✅ Work sources — 1 tracker query, 0 automations, 0 error monitors, 1 repo",
        "✅ Tracker credentials — jira ([defaults])",
        "✅ Task query — jira ([defaults]): 2 tasks match",
        "✅ Everything looks good — start the worker with `devintern worker`.",
      ]);
      expect(ready.stdout).not.toContain("❌");
      expect(tracker.searches).toEqual([query]);

      // --offline still checks credentials (local) but skips the dry run.
      const offline = await doctor(["--offline"]);
      expect(offline.exitCode, offline.stdout).toBe(0);
      expectLines(offline, [
        "✅ Tracker credentials — jira ([defaults])",
        "⚠️  Task query — jira ([defaults]): skipped (--offline)",
        "💡 Rerun `devintern worker doctor` without --offline to dry-run the query",
      ]);
      expect(tracker.searches).toEqual([query]);

      // (b) Jira rejects the query (unknown status): 400 with errorMessages.
      const rejectedQuery = `status = "Ready for Dev" AND ${query}`;
      tracker.rejectSearchesContaining('"Ready for Dev"', UNKNOWN_STATUS);
      const original = readFileSync(configPath, "utf8");
      writeFileSync(
        configPath,
        original.replace(
          `task_query = ${JSON.stringify(query)}`,
          `task_query = ${JSON.stringify(rejectedQuery)}`,
        ),
      );
      const rejected = await doctor();
      expect(rejected.exitCode, rejected.stdout).toBe(1);
      expectLines(rejected, [
        "✅ Tracker credentials — jira ([defaults])",
        `❌ Task query — jira ([defaults]): Failed to search issues with JQL: ${rejectedQuery}`,
        "JIRA API Error: 400",
        UNKNOWN_STATUS,
        "💡 Fix [defaults].task_query in workspace.toml (renamed status, project, or field?)",
        NOT_READY,
      ]);
      // A 400 is not retried: exactly one more search, carrying the new JQL.
      expect(tracker.searches).toEqual([query, rejectedQuery]);
      writeFileSync(configPath, original);

      // Gap 2: JIRA_API_TOKEN absent from the workspace .env. The credential
      // row names the variable and the .env path; no request reaches the fake.
      const { JIRA_API_TOKEN: _dropped, ...withoutToken } = credentials;
      writeFileSync(envPath, dotenv(withoutToken), { mode: 0o600 });
      const missing = await doctor();
      expect(missing.exitCode, missing.stdout).toBe(1);
      expectLines(missing, [
        "❌ Tracker credentials — jira ([defaults]): missing JIRA_API_TOKEN",
        `💡 Add the missing variables to ${envPath}`,
        "❌ Task query — jira ([defaults]): not run (missing tracker credentials)",
        NOT_READY,
      ]);
      // --offline does not hide a missing credential; only the dry run is skipped.
      const missingOffline = await doctor(["--offline"]);
      expect(missingOffline.exitCode, missingOffline.stdout).toBe(1);
      expectLines(missingOffline, [
        "❌ Tracker credentials — jira ([defaults]): missing JIRA_API_TOKEN",
        "⚠️  Task query — jira ([defaults]): skipped (--offline)",
      ]);
      expect(tracker.searches).toEqual([query, rejectedQuery]);

      expect(tracker.unexpectedRequests).toEqual([]);
      expect(existsSync(worker.dbPath)).toBe(false);
      expect(existsSync(worker.lockFile)).toBe(false);
      expect(proxy.requests()).toEqual([]);
    } finally {
      try {
        await worker.dispose();
      } finally {
        try {
          await tracker.cleanup();
        } finally {
          await proxy?.close();
        }
      }
    }
  },
  120_000,
);

test.skipIf(!builtCli)(
  "worker doctor checks each [[teams]] source with its own credentials and fails only the broken team",
  async () => {
    const alpha = new FakeJiraTracker({ projectKey: "ALPHA" });
    const beta = new FakeJiraTracker({ projectKey: "BETA" });
    const alphaMarker = randomToken("E2EALPHA");
    const betaMarker = randomToken("E2EBETA");
    const alphaQuery = `text ~ "${alphaMarker}"`;
    const betaQuery = `text ~ "${betaMarker}"`;
    const alphaToken = randomToken("e2e-jira-alpha-");
    const betaToken = randomToken("e2e-jira-beta-");
    let proxy: RecordingProxy | undefined;
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-worker-doctor-teams-",
      tracker: "jira",
    });
    try {
      proxy = await startRecordingProxy();
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      await worker.prepare();
      const configPath = join(worker.workspaceDir, "workspace.toml");
      const alphaEnvPath = join(worker.workspaceDir, "env", "alpha.env");
      // The shared workspace .env carries no tracker credentials.
      writeFileSync(join(worker.workspaceDir, ".env"), "", { mode: 0o600 });
      mkdirSync(join(worker.workspaceDir, "env"), { recursive: true });
      const alphaCredentials = jiraEnv(alpha, alphaToken);
      writeFileSync(alphaEnvPath, dotenv(alphaCredentials), { mode: 0o600 });
      const base = readFileSync(configPath, "utf8");
      const writeTeams = (betaEnv: Record<string, string>) =>
        writeFileSync(
          configPath,
          [
            base,
            "[[teams]]",
            'name = "alpha"',
            'tracker = "jira"',
            `task_query = ${JSON.stringify(alphaQuery)}`,
            'env_file = "env/alpha.env"',
            "",
            "[[teams]]",
            'name = "beta"',
            'tracker = "jira"',
            `task_query = ${JSON.stringify(betaQuery)}`,
            "  [teams.env]",
            ...Object.entries(betaEnv).map(([key, value]) => `  ${key} = ${JSON.stringify(value)}`),
            "",
          ].join("\n"),
        );
      const betaCredentials = jiraEnv(beta, betaToken);
      writeTeams(betaCredentials);
      await alpha.createTicket({ title: "Alpha ready", body: `Alpha.\n\n${alphaMarker}\n` });
      await beta.createTicket({ title: "Beta ready one", body: `Beta.\n\n${betaMarker}\n` });
      await beta.createTicket({ title: "Beta ready two", body: `Beta.\n\n${betaMarker}\n` });
      const doctor = (args: string[] = []) => doctorWithout(worker, [alphaToken, betaToken], args);
      const alphaLabel = 'jira (team "alpha")';
      const betaLabel = 'jira (team "beta")';

      // Both teams pass, each against its own fake with its own JQL.
      const ready = await doctor();
      expect(ready.exitCode, ready.stdout).toBe(0);
      expectLines(ready, [
        `✅ Workspace config — 1 repo, 2 teams, 0 automations (${configPath})`,
        `✅ Tracker credentials — ${alphaLabel}`,
        `✅ Tracker credentials — ${betaLabel}`,
        `✅ Task query — ${alphaLabel}: 1 task matches`,
        `✅ Task query — ${betaLabel}: 2 tasks match`,
      ]);
      expect(ready.stdout).not.toContain("❌");
      expect(alpha.searches).toEqual([alphaQuery]);
      expect(beta.searches).toEqual([betaQuery]);

      // --offline: credentials still checked per team, both dry runs skipped.
      const offline = await doctor(["--offline"]);
      expect(offline.exitCode, offline.stdout).toBe(0);
      expectLines(offline, [
        `✅ Tracker credentials — ${alphaLabel}`,
        `✅ Tracker credentials — ${betaLabel}`,
        `⚠️  Task query — ${alphaLabel}: skipped (--offline)`,
        `⚠️  Task query — ${betaLabel}: skipped (--offline)`,
      ]);
      expect(alpha.searches).toEqual([alphaQuery]);
      expect(beta.searches).toEqual([betaQuery]);

      // Beta loses JIRA_API_TOKEN from [teams.env]: only beta fails; the hint
      // names the team (no env_file to name). Beta's fake sees no request.
      const { JIRA_API_TOKEN: _betaDropped, ...betaWithoutToken } = betaCredentials;
      writeTeams(betaWithoutToken);
      const betaMissing = await doctor();
      expect(betaMissing.exitCode, betaMissing.stdout).toBe(1);
      expectLines(betaMissing, [
        `✅ Tracker credentials — ${alphaLabel}`,
        `❌ Tracker credentials — ${betaLabel}: missing JIRA_API_TOKEN`,
        '💡 Add the missing variables to the workspace .env, a team env_file, or [teams.env] for "beta"',
        `✅ Task query — ${alphaLabel}: 1 task matches`,
        `❌ Task query — ${betaLabel}: not run (missing tracker credentials)`,
        NOT_READY,
      ]);
      expect(betaMissing.stdout).not.toContain(`❌ Tracker credentials — ${alphaLabel}`);
      expect(alpha.searches).toEqual([alphaQuery, alphaQuery]);
      expect(beta.searches).toEqual([betaQuery]);
      writeTeams(betaCredentials);

      // Alpha loses JIRA_API_TOKEN from its env_file: the hint names the file.
      const { JIRA_API_TOKEN: _alphaDropped, ...alphaWithoutToken } = alphaCredentials;
      writeFileSync(alphaEnvPath, dotenv(alphaWithoutToken), { mode: 0o600 });
      const alphaMissing = await doctor();
      expect(alphaMissing.exitCode, alphaMissing.stdout).toBe(1);
      expectLines(alphaMissing, [
        `❌ Tracker credentials — ${alphaLabel}: missing JIRA_API_TOKEN`,
        '💡 Add the missing variables to the workspace .env, env/alpha.env, or [teams.env] for "alpha"',
        `❌ Task query — ${alphaLabel}: not run (missing tracker credentials)`,
        `✅ Tracker credentials — ${betaLabel}`,
        `✅ Task query — ${betaLabel}: 2 tasks match`,
      ]);
      expect(alpha.searches).toEqual([alphaQuery, alphaQuery]);
      expect(beta.searches).toEqual([betaQuery, betaQuery]);
      writeFileSync(alphaEnvPath, dotenv(alphaCredentials), { mode: 0o600 });

      // Alpha's fake rejects its query: only alpha fails, with the team hint.
      alpha.rejectSearchesContaining(alphaMarker, UNKNOWN_STATUS);
      const alphaRejected = await doctor();
      expect(alphaRejected.exitCode, alphaRejected.stdout).toBe(1);
      expectLines(alphaRejected, [
        `✅ Tracker credentials — ${alphaLabel}`,
        `❌ Task query — ${alphaLabel}: Failed to search issues with JQL: ${alphaQuery}`,
        UNKNOWN_STATUS,
        '💡 Fix task_query for [[teams]] "alpha" in workspace.toml (renamed status, project, or field?)',
        `✅ Task query — ${betaLabel}: 2 tasks match`,
        NOT_READY,
      ]);
      expect(alpha.searches).toEqual([alphaQuery, alphaQuery, alphaQuery]);
      expect(beta.searches).toEqual([betaQuery, betaQuery, betaQuery]);

      for (const tracker of [alpha, beta]) expect(tracker.unexpectedRequests).toEqual([]);
      expect(existsSync(worker.dbPath)).toBe(false);
      expect(existsSync(worker.lockFile)).toBe(false);
      expect(proxy.requests()).toEqual([]);
    } finally {
      try {
        await worker.dispose();
      } finally {
        try {
          await Promise.allSettled([alpha.cleanup(), beta.cleanup()]);
        } finally {
          await proxy?.close();
        }
      }
    }
  },
  120_000,
);
