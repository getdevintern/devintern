/**
 * `GET /api/workspace`: teams and error-monitor redaction (standalone
 * dashboard) and the `configSync` / `appliedConfig` state against a running
 * worker (worker-embedded dashboard), both against the built CLI.
 *
 * Production behavior under test:
 * - `packages/code/src/lib/observability/dashboard-workspace.ts`
 *   `toWorkspaceConfigView` (teams, repos, and monitors reduced to env key
 *   names; `redactUrlCredentials` on repo remotes and monitor `base_url`),
 *   `loadDashboardWorkspaceConfig` (typed `invalid` state, quoted fragments
 *   masked) and `deriveConfigSync` (`redactReason` on rejection reasons).
 * - `packages/code/src/lib/workspace/config-reload.ts`
 *   `appliedConfigRecorder`: the worker records each applied or rejected
 *   reload of `workspace.toml`.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DashboardFixture,
  dashboardBaseUrl,
  waitForDashboardHealth,
} from "../../helpers/dashboard";
import { freePort } from "../../helpers/webhook-server";
import { automationTable, cliPath, WorkerFixture } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

// Midnight on January 1st: these automations never come due during the test.
const NEVER_CRON = "0 0 1 1 *";

interface EnvFileView {
  path: string;
  resolvedPath: string;
  exists: boolean;
  keys: string[];
}

interface WorkspaceBody {
  status: "ok" | "missing" | "invalid";
  configPath: string;
  error?: string;
  problems?: string[];
  workerStartedAt?: number;
  configSync?: "applied" | "pending" | "rejected" | "unconfirmed";
  appliedConfig?: {
    appliedAt: number;
    fileModifiedAt: number;
    rejectedReason?: string;
    rejectedAt?: number;
  };
  config?: {
    teams: Array<{
      name: string;
      tracker: string;
      taskQuery?: string;
      repo?: string;
      envFile?: EnvFileView;
      envKeys: string[];
    }>;
    repos: Array<{
      name: string;
      remote: string;
      defaultBranch?: string;
      envFile?: EnvFileView;
      envKeys: string[];
    }>;
    automations: Array<{ id: string }>;
    errorMonitors: Array<{
      id: string;
      provider: string;
      repo: string;
      team?: string;
      organization: string;
      project: string;
      baseUrl?: string;
      envFile?: EnvFileView;
      envKeys: string[];
    }>;
  };
}

/** A fake, secret-shaped value: `ghp_` + 36 alphanumerics (never a real token). */
function fakeGithubToken(): string {
  return `ghp_${crypto.randomUUID().replaceAll("-", "")}E2E0`;
}

/** Raw, URL-encoded, and base64 forms of a secret (base64 also as Basic auth). */
function secretForms(secret: string, user?: string): string[] {
  const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")];
  if (user) forms.push(Buffer.from(`${user}:${secret}`).toString("base64"));
  return [...new Set(forms)];
}

/** Fail with a message that never prints the secret itself. */
function expectNoSecret(label: string, text: string, secrets: string[][]): void {
  for (const [index, forms] of secrets.entries()) {
    for (const [formIndex, form] of forms.entries()) {
      if (text.includes(form)) {
        throw new Error(`${label} leaked secret #${index} (form #${formIndex})`);
      }
    }
  }
}

async function getWorkspace(url: string): Promise<{ text: string; body: WorkspaceBody }> {
  const response = await fetch(url);
  const text = await response.text();
  // Missing and invalid configs are typed 200 states, never a 500.
  expect(response.status).toBe(200);
  return { text, body: JSON.parse(text) as WorkspaceBody };
}

test.skipIf(!builtCli)(
  "GET /api/workspace reduces teams and error monitors to key names and strips base_url userinfo",
  async () => {
    const worker = new WorkerFixture();
    let dashboard: DashboardFixture | undefined;
    const sentryUser = "e2e-sentry-user";
    const sentryPassword = `fake-sentry-pass-${crypto.randomUUID()}`;
    const remoteUser = "e2e-git-user";
    const remotePassword = `fake-remote-pass-${crypto.randomUUID()}`;
    const teamInlineToken = fakeGithubToken();
    const teamEnvFileToken = `fake-team-env-file-${crypto.randomUUID()}`;
    const repoInlineToken = fakeGithubToken();
    const monitorInlineToken = `sntrys_fake${crypto.randomUUID().replaceAll("-", "")}`;
    const monitorEnvFileToken = `fake-monitor-env-file-${crypto.randomUUID()}`;
    const unquotedToken = fakeGithubToken();
    const secrets = [
      secretForms(sentryPassword, sentryUser),
      secretForms(remotePassword, remoteUser),
      secretForms(teamInlineToken),
      secretForms(teamEnvFileToken),
      secretForms(repoInlineToken),
      secretForms(monitorInlineToken),
      secretForms(monitorEnvFileToken),
      secretForms(unquotedToken),
    ];
    try {
      // prepare() supplies the deterministic AGENT_CLI_PATH the CLI resolves
      // before dispatching `dashboard`; the worker itself is never started.
      await worker.prepare();
      const ws = worker.workspaceDir;
      const configPath = join(ws, "workspace.toml");
      mkdirSync(join(ws, "env"), { recursive: true });
      writeFileSync(
        join(ws, "env", "team-beta.env"),
        `BETA_TRACKER_TOKEN=${teamEnvFileToken}\nBETA_REGION=eu-e2e-beta\n`,
      );
      writeFileSync(
        join(ws, "env", "sentry.env"),
        `SENTRY_AUTH_TOKEN=${monitorEnvFileToken}\nSENTRY_HINT=visible-monitor-hint\n`,
      );
      // Port 9 on loopback: nothing listens and the standalone dashboard never
      // polls monitors, so no request is made.
      const sentryHostPath = "127.0.0.1:9/sentry-e2e";
      writeFileSync(
        configPath,
        [
          "[defaults]",
          'tracker = "markdown"',
          "",
          "[[repos]]",
          'name = "svc"',
          `remote = "https://${remoteUser}:${remotePassword}@git.e2e.invalid/org/svc.git"`,
          'default_branch = "main"',
          "",
          "[repos.env]",
          `SVC_API_TOKEN = "${repoInlineToken}"`,
          "",
          "[[teams]]",
          'name = "alpha"',
          'tracker = "markdown"',
          'task_query = "status=todo group=alpha"',
          'repo = "svc"',
          "",
          "[teams.env]",
          `ALPHA_TRACKER_TOKEN = "${teamInlineToken}"`,
          'ALPHA_PLAIN = "visible-team-plain"',
          "",
          "[[teams]]",
          'name = "beta"',
          'tracker = "markdown"',
          'task_query = "status=todo group=beta"',
          'env_file = "env/team-beta.env"',
          "",
          "[[error_monitors]]",
          'id = "sentry-e2e"',
          'provider = "sentry"',
          'repo = "svc"',
          'team = "alpha"',
          'organization = "e2e-org"',
          'project = "e2e-project"',
          `base_url = "http://${sentryUser}:${sentryPassword}@${sentryHostPath}"`,
          "poll_interval = 3600",
          'env_file = "env/sentry.env"',
          "",
          "[error_monitors.env]",
          `SENTRY_INLINE_TOKEN = "${monitorInlineToken}"`,
          "",
        ].join("\n"),
      );

      dashboard = await DashboardFixture.start(worker);
      const url = `${dashboard.baseUrl}/api/workspace`;

      // --- valid config: names and key names only ---------------------------
      const ok = await getWorkspace(url);
      expectNoSecret("workspace (ok)", ok.text, secrets);
      for (const plain of ["visible-team-plain", "eu-e2e-beta", "visible-monitor-hint"]) {
        expect(ok.text).not.toContain(plain);
      }
      expect(ok.text).not.toContain(sentryUser);
      expect(ok.text).not.toContain(remoteUser);
      expect(ok.body.status).toBe("ok");
      // No running worker: there is nothing to sync against.
      expect(ok.body.configSync).toBeUndefined();
      expect(ok.body.appliedConfig).toBeUndefined();
      expect(ok.body.config?.teams).toEqual([
        {
          name: "alpha",
          tracker: "markdown",
          taskQuery: "status=todo group=alpha",
          repo: "svc",
          envKeys: ["ALPHA_PLAIN", "ALPHA_TRACKER_TOKEN"],
        },
        {
          name: "beta",
          tracker: "markdown",
          taskQuery: "status=todo group=beta",
          envFile: {
            path: "env/team-beta.env",
            resolvedPath: join(ws, "env", "team-beta.env"),
            exists: true,
            keys: ["BETA_REGION", "BETA_TRACKER_TOKEN"],
          },
          envKeys: [],
        },
      ]);
      expect(ok.body.config?.repos).toEqual([
        {
          name: "svc",
          remote: "https://git.e2e.invalid/org/svc.git",
          defaultBranch: "main",
          envKeys: ["SVC_API_TOKEN"],
        },
      ]);
      expect(ok.body.config?.errorMonitors).toHaveLength(1);
      expect(ok.body.config?.errorMonitors[0]).toMatchObject({
        id: "sentry-e2e",
        provider: "sentry",
        repo: "svc",
        team: "alpha",
        organization: "e2e-org",
        project: "e2e-project",
        // Userinfo removed; scheme, host, port, and path kept.
        baseUrl: `http://${sentryHostPath}`,
        envFile: {
          path: "env/sentry.env",
          resolvedPath: join(ws, "env", "sentry.env"),
          exists: true,
          keys: ["SENTRY_AUTH_TOKEN", "SENTRY_HINT"],
        },
        envKeys: ["SENTRY_INLINE_TOKEN"],
      });

      // --- TOML syntax error quoting an unquoted token -----------------------
      writeFileSync(
        configPath,
        [
          "[defaults]",
          'tracker = "markdown"',
          "",
          "[[teams]]",
          'name = "alpha"',
          'tracker = "markdown"',
          "[teams.env]",
          `ALPHA_TRACKER_TOKEN = ${unquotedToken}`,
          "",
        ].join("\n"),
      );
      const syntax = await getWorkspace(url);
      expectNoSecret("workspace (syntax error)", syntax.text, secrets);
      expect(syntax.body.status).toBe("invalid");
      expect(syntax.body.error).toStartWith(`Failed to parse ${configPath}`);
      expect(syntax.body.problems).toHaveLength(1);
      expect(syntax.body.config).toBeUndefined();

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  60_000,
);

test.skipIf(!builtCli)(
  "the worker-embedded GET /api/workspace reports configSync applied, then rejected with the reason masked",
  async () => {
    const port = await freePort();
    const worker = new WorkerFixture({
      automations: [{ id: "e2e-sync-base", cron: NEVER_CRON, prompt: "never runs" }],
      dashboard: { port, tailscaleAutodetect: false },
    });
    const baseUrl = dashboardBaseUrl("127.0.0.1", port);
    const url = `${baseUrl}/api/workspace`;
    const rejectedToken = fakeGithubToken();
    const monitorUser = "e2e-live-sentry-user";
    const monitorPassword = `fake-live-sentry-pass-${crypto.randomUUID()}`;
    const monitorInlineToken = `sntrys_fake${crypto.randomUUID().replaceAll("-", "")}`;
    const monitorSecrets = [
      secretForms(monitorPassword, monitorUser),
      secretForms(monitorInlineToken),
    ];
    const secrets = [secretForms(rejectedToken), ...monitorSecrets];

    /** Poll the embedded route until `accept` holds (bounded, never a fixed sleep). */
    async function pollWorkspace(
      label: string,
      accept: (body: WorkspaceBody) => boolean,
      timeoutMs = 20_000,
    ): Promise<{ text: string; body: WorkspaceBody }> {
      const deadline = Date.now() + timeoutMs;
      let last: WorkspaceBody | undefined;
      for (;;) {
        if (!worker.running)
          throw new Error(`worker exited waiting for ${label}\n${worker.tail()}`);
        const result = await getWorkspace(url);
        // Validation `problems` echo quoted values verbatim (only TOML syntax
        // errors are masked there); every other field must stay secret-free.
        // The documented gap is recorded in docs/coverage/dashboard.md.
        const scanned = JSON.stringify({ ...result.body, problems: undefined });
        expectNoSecret(`workspace (${label})`, scanned, secrets);
        last = result.body;
        if (accept(result.body)) return result;
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for ${label}; last configSync=${String(last.configSync)} ` +
              `status=${last.status}\n${worker.tail()}`,
          );
        }
        await Bun.sleep(100);
      }
    }

    try {
      await worker.prepare();
      const configPath = join(worker.workspaceDir, "workspace.toml");
      worker.start();
      await worker.waitForReady();
      await waitForDashboardHealth(baseUrl, {
        assertAlive: () => {
          if (!worker.running) throw new Error(`worker exited\n${worker.tail()}`);
        },
        describe: () => worker.tail(),
      });

      // --- 1. startup: the running worker applied the file on disk ----------
      const initial = await pollWorkspace(
        "startup applied",
        (body) => body.configSync === "applied" && body.appliedConfig !== undefined,
      );
      expect(initial.body.status).toBe("ok");
      expect(initial.body.workerStartedAt).toBeNumber();
      const firstAppliedAt = initial.body.appliedConfig!.appliedAt;
      expect(firstAppliedAt).toBeGreaterThan(0);
      expect(initial.body.appliedConfig?.rejectedReason).toBeUndefined();
      expect(initial.body.config?.automations.map((item) => item.id)).toEqual(["e2e-sync-base"]);

      // --- 2. a valid hot-reloadable edit is applied again ------------------
      worker.appendAutomation({ id: "e2e-sync-added", cron: NEVER_CRON, prompt: "never runs" });
      const reloaded = await pollWorkspace(
        "valid edit applied",
        (body) =>
          body.configSync === "applied" && (body.appliedConfig?.appliedAt ?? 0) > firstAppliedAt,
      );
      await worker.waitForOutput(/\[config\] Reloaded /, 10_000, "config reload log");
      expect(reloaded.body.status).toBe("ok");
      expect(reloaded.body.appliedConfig?.rejectedReason).toBeUndefined();
      expect(reloaded.body.appliedConfig?.fileModifiedAt).toBeGreaterThanOrEqual(
        initial.body.appliedConfig!.fileModifiedAt,
      );
      expect(reloaded.body.config?.automations.map((item) => item.id)).toEqual([
        "e2e-sync-base",
        "e2e-sync-added",
      ]);
      const appliedFile = readFileSync(configPath, "utf8");

      // --- 3. a valid file with a startup-only change is rejected -----------
      // Adding a credentialed `[[error_monitors]]` live: the loader accepts it
      // (status "ok"), the worker refuses it until restart.
      writeFileSync(
        configPath,
        [
          appliedFile.trimEnd(),
          "",
          "[[error_monitors]]",
          'id = "sentry-live"',
          'provider = "sentry"',
          'organization = "e2e-org"',
          'project = "e2e-project"',
          `base_url = "http://${monitorUser}:${monitorPassword}@127.0.0.1:9/sentry-e2e"`,
          "poll_interval = 3600",
          "",
          "[error_monitors.env]",
          `SENTRY_INLINE_TOKEN = "${monitorInlineToken}"`,
          "",
        ].join("\n"),
      );
      const startupOnly = await pollWorkspace(
        "startup-only edit rejected",
        (body) => body.configSync === "rejected",
      );
      // The whole body (problems included) is free of the monitor secrets.
      expectNoSecret("workspace (startup-only rejection)", startupOnly.text, monitorSecrets);
      expect(startupOnly.text).not.toContain(monitorUser);
      expect(startupOnly.body.status).toBe("ok");
      // The worker still runs the version applied in step 2.
      expect(startupOnly.body.appliedConfig?.fileModifiedAt).toBe(
        reloaded.body.appliedConfig!.fileModifiedAt,
      );
      expect(startupOnly.body.appliedConfig?.rejectedReason).toBe(
        "[[error_monitors]] is startup-only; restart the worker to change it.",
      );
      expect(startupOnly.body.config?.errorMonitors).toEqual([
        expect.objectContaining({
          id: "sentry-live",
          repo: worker.repoName,
          baseUrl: "http://127.0.0.1:9/sentry-e2e",
          envKeys: ["SENTRY_INLINE_TOKEN"],
        }),
      ]);
      const firstRejectedAt = startupOnly.body.appliedConfig!.rejectedAt!;
      expect(firstRejectedAt).toBeNumber();

      // --- 4. a parseable edit the reload rejects, quoting a secret ----------
      // `[[automations]][N].repo "<value>" does not match any [[repos]] name.`
      writeFileSync(
        configPath,
        `${appliedFile.trimEnd()}\n\n${automationTable({
          id: "e2e-sync-leaky",
          cron: NEVER_CRON,
          prompt: "never runs",
          repo: rejectedToken,
        }).join("\n")}\n`,
      );
      const rejected = await pollWorkspace(
        "quoted-value edit rejected",
        (body) =>
          body.configSync === "rejected" &&
          (body.appliedConfig?.rejectedReason ?? "").includes("does not match any [[repos]] name"),
      );
      // The worker really saw the value (its own stderr); the API masks it.
      await worker.waitFor("the rejected reload log", () =>
        worker.logs.includes(rejectedToken) ? true : undefined,
      );
      const applied = rejected.body.appliedConfig;
      expect(applied?.fileModifiedAt).toBe(reloaded.body.appliedConfig!.fileModifiedAt);
      expect(applied?.rejectedAt).toBeNumber();
      expect(applied!.rejectedAt!).toBeGreaterThanOrEqual(firstRejectedAt);
      expect(applied?.rejectedReason).toContain('.repo "…" does not match any [[repos]] name.');
      // The dashboard's own load of the same file is a typed `invalid` state.
      // Its `problems` quote the value verbatim (not asserted as desired
      // behavior; see the Missing note in docs/coverage/dashboard.md).
      expect(rejected.body.status).toBe("invalid");
      expect(rejected.body.error).toBe(`Invalid ${configPath}`);
      expect(rejected.body.problems).toContainEqual(
        expect.stringContaining("does not match any [[repos]] name."),
      );
      expect(rejected.body.config).toBeUndefined();

      // The worker kept serving the previous config.
      const automations = (await (await fetch(`${baseUrl}/api/automations`)).json()) as {
        automations: Array<{ id: string }>;
      };
      expect(automations.automations.map((item) => item.id)).toEqual([
        "e2e-sync-base",
        "e2e-sync-added",
      ]);
      expect(worker.running, worker.tail()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);
