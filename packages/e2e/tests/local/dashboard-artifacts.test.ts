import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DashboardFixture } from "../../helpers/dashboard";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

/** The product's redaction placeholder (`redactSecrets` in worker-logs.ts). */
const REDACTED = "[redacted]";

interface RunArtifact {
  id: string;
  runId: number | null;
  key: string;
  kind: string;
  mediaType: string;
  name: string;
  size: number;
  available: boolean;
}

interface ArtifactContent {
  name: string;
  content: string | null;
  truncated: boolean;
  totalBytes: number;
}

interface HarnessLogFile {
  name: string;
  runId?: number;
  taskKey?: string;
}

interface HarnessLogContent {
  name: string;
  content: string;
  truncated: boolean;
  totalBytes: number;
}

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
  config?: {
    defaults: { tracker: string };
    sharedEnv: EnvFileView;
    repos: Array<{
      name: string;
      remote: string;
      defaultBranch?: string;
      envFile?: EnvFileView;
      envKeys: string[];
    }>;
  };
}

/** A fake, secret-shaped value: `ghp_` + 36 alphanumerics (never a real token). */
function fakeGithubToken(): string {
  return `ghp_${crypto.randomUUID().replaceAll("-", "")}E2E0`;
}

/** Fail with a message that never prints the secret itself. */
function expectNoSecret(label: string, text: string, secrets: string[]): void {
  for (const [index, secret] of secrets.entries()) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      if (text.includes(form)) {
        throw new Error(`${label} leaked secret #${index} (raw or URL-encoded form)`);
      }
    }
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.text();
  if (response.status !== 200) {
    throw new Error(`GET ${new URL(url).pathname} returned ${response.status}`);
  }
  return JSON.parse(body) as T;
}

async function errorStatus(url: string): Promise<{ status: number; error: unknown }> {
  const response = await fetch(url);
  const text = await response.text();
  let error: unknown = text;
  try {
    error = (JSON.parse(text) as { error?: unknown }).error;
  } catch {
    // Non-JSON bodies are reported as-is.
  }
  return { status: response.status, error };
}

test.skipIf(!builtCli)(
  "run artifact and harness-log readback is redacted over HTTP and through `worker runs`",
  async () => {
    const leak = fakeGithubToken();
    const worker = new WorkerFixture({
      // `[defaults].pipeline_file` (resolved against the workspace directory)
      // adds a verify step after commit. Its prompt marker makes the
      // deterministic agent answer with a verdict echoing the fake token.
      workspaceTomlExtra: 'pipeline_file = "e2e-pipeline.json"',
      env: { E2E_AGENT_LEAK_TOKEN: leak },
    });
    const marker = `E2E_DASHBOARD_ARTIFACT_${crypto.randomUUID()}`;
    worker.env.E2E_EXPECT_DESCRIPTION_MARKER = marker;
    let dashboard: DashboardFixture | undefined;
    try {
      await worker.prepare();
      writeFileSync(
        join(worker.workspaceDir, "e2e-pipeline.json"),
        JSON.stringify({
          steps: [
            { use: "implement" },
            { use: "commit" },
            {
              use: "verify",
              prompt:
                'E2EVERIFYVERDICT Verify the change. Return only JSON: {"summary":"...","items":[],"approved":true}.',
              onFail: "halt",
            },
            { use: "finalize" },
          ],
        }),
      );
      const task = await worker.addTask({
        title: "Expose run artifacts",
        body: `Change the greeting to Hello, world! and run bun test.\n\n${marker}`,
      });
      worker.start();
      await worker.waitForReady();

      const { task: settled, runs } = await worker.waitForSettled(task.id);
      // The worker log can hold the raw token (the agent's stdout); keep
      // diagnostics redacted before they reach a failure message.
      const diagnostics = () =>
        [
          `injected task #${task.id} settled as "${settled.status}": ${settled.message ?? ""}`,
          `runs: ${JSON.stringify(runs)}`,
          `invocations: ${JSON.stringify(worker.agentInvocations())}`,
          worker.tail(),
        ]
          .join("\n")
          .replaceAll(leak, "<leak>");
      expect(settled.status, diagnostics()).toBe("done");
      expect(runs, diagnostics()).toHaveLength(1);
      const run = runs[0];
      if (!run) throw new Error(`no run recorded\n${diagnostics()}`);
      expect(run.status, diagnostics()).toBe("succeeded");
      expect(
        worker.agentInvocations().map((entry) => entry.mode),
        diagnostics(),
      ).toEqual(["implement", "verify"]);

      dashboard = await DashboardFixture.start(worker);
      const api = `${dashboard.baseUrl}/api/runs/${run.id}`;

      // --- artifact list ------------------------------------------------------
      const { artifacts } = await getJson<{ artifacts: RunArtifact[] }>(`${api}/artifacts`);
      const feedback = artifacts.find((artifact) => artifact.key === "verification");
      const verifyPrompt = artifacts.find((artifact) => artifact.key === "verification-prompt");
      expect(feedback, JSON.stringify(artifacts)).toMatchObject({
        runId: run.id,
        kind: "verification",
        mediaType: "application/json",
        name: "verify-feedback.json",
        available: true,
      });
      expect(verifyPrompt, JSON.stringify(artifacts)).toMatchObject({
        runId: run.id,
        mediaType: "text/plain",
        name: "verify-prompt.txt",
        available: true,
      });
      if (!feedback || !verifyPrompt) throw new Error("verification artifacts missing");
      expectNoSecret("artifact list", JSON.stringify(artifacts), [leak]);

      // --- one artifact's content ---------------------------------------------
      const contentResponse = await fetch(`${api}/artifacts/${feedback.id}`);
      expect(contentResponse.status).toBe(200);
      const contentText = await contentResponse.text();
      expectNoSecret("artifact content", contentText, [leak]);
      const content = JSON.parse(contentText) as ArtifactContent;
      expect(content.name).toBe("verify-feedback.json");
      expect(content.truncated).toBe(false);
      expect(content.totalBytes).toBe(feedback.size);
      const body = content.content ?? "";
      // Non-secret verdict fields survive; the echoed token is replaced by the
      // product's placeholder under both the token-shape and key-name rules.
      expect(body).toContain('"summary": "E2E verification approved the greeting change."');
      expect(body).toContain('"approved": true');
      expect(body).toContain(
        `Checked the fixture with token ${REDACTED} and E2E_API_TOKEN=${REDACTED} before approving.`,
      );

      const promptContent = await getJson<ArtifactContent>(`${api}/artifacts/${verifyPrompt.id}`);
      expect(promptContent.content).toContain("E2EVERIFYVERDICT Verify the change.");
      expect(promptContent.content).toContain(marker);

      // --- the /file download serves the same sanitized bytes ----------------
      const file = await fetch(`${api}/artifacts/${feedback.id}/file`);
      expect(file.status).toBe(200);
      // JSON is not a safe inline preview type, so it is always an attachment.
      expect(file.headers.get("content-type")).toBe("application/octet-stream");
      expect(file.headers.get("content-disposition")).toBe(
        "attachment; filename*=UTF-8''verify-feedback.json",
      );
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      const fileText = await file.text();
      expectNoSecret("artifact file", fileText, [leak]);
      expect(fileText).toBe(body);

      // --- harness-log content ------------------------------------------------
      const { harnessLogs } = await getJson<{ harnessLogs: HarnessLogFile[] }>(
        `${api}/harness-logs`,
      );
      expect(harnessLogs.length, JSON.stringify(harnessLogs)).toBeGreaterThanOrEqual(2);
      let verifyLog: HarnessLogContent | undefined;
      for (const log of harnessLogs) {
        const logText = await (
          await fetch(`${api}/harness-logs/${encodeURIComponent(log.name)}`)
        ).text();
        expectNoSecret(`harness log ${log.name}`, logText, [leak]);
        const parsed = JSON.parse(logText) as HarnessLogContent;
        if (parsed.content.includes("E2E verification approved the greeting change.")) {
          verifyLog = parsed;
        }
      }
      if (!verifyLog)
        throw new Error(`no harness log holds the verify turn: ${harnessLogs.length}`);
      expect(verifyLog.truncated).toBe(false);
      expect(verifyLog.content).toContain(
        `Checked the fixture with token ${REDACTED} and E2E_API_TOKEN=${REDACTED} before approving.`,
      );

      // --- refusals are 4xx, never 500 ----------------------------------------
      const unknownId = crypto.randomUUID();
      expect(await errorStatus(`${api}/artifacts/${unknownId}`)).toEqual({
        status: 404,
        error: "artifact not found",
      });
      expect(await errorStatus(`${api}/artifacts/${unknownId}/file`)).toEqual({
        status: 404,
        error: "artifact not found",
      });
      expect(await errorStatus(`${api}/harness-logs/missing.log`)).toEqual({
        status: 404,
        error: "harness log not found",
      });
      const malformed = `${dashboard.baseUrl}/api/runs/not-an-int`;
      for (const path of [
        "/artifacts",
        `/artifacts/${feedback.id}`,
        "/harness-logs",
        "/harness-logs/x.log",
      ]) {
        expect(await errorStatus(`${malformed}${path}`), path).toEqual({
          status: 400,
          error: "run id must be an integer",
        });
      }
      // The /file route only matches a positive integer run id; anything else
      // falls through to the API's generic 404.
      expect(await errorStatus(`${malformed}/artifacts/${feedback.id}/file`)).toEqual({
        status: 404,
        error: "not found",
      });
      // An artifact id from this run is not served under another run id.
      expect((await errorStatus(`${dashboard.baseUrl}/api/runs/2147483647/artifacts`)).status).toBe(
        404,
      );

      // --- `devintern worker runs` parity -------------------------------------
      const cliArtifact = await worker.runCli([
        "worker",
        "runs",
        "artifacts",
        String(run.id),
        feedback.id,
        "--json",
      ]);
      expect(cliArtifact.exitCode, cliArtifact.stderr.replaceAll(leak, "<leak>")).toBe(0);
      expectNoSecret("worker runs artifacts", cliArtifact.stdout + cliArtifact.stderr, [leak]);
      expect(JSON.parse(cliArtifact.stdout)).toEqual(content);

      const cliLog = await worker.runCli([
        "worker",
        "runs",
        "logs",
        String(run.id),
        verifyLog.name,
        "--json",
      ]);
      expect(cliLog.exitCode, cliLog.stderr.replaceAll(leak, "<leak>")).toBe(0);
      expectNoSecret("worker runs logs", cliLog.stdout + cliLog.stderr, [leak]);
      expect(JSON.parse(cliLog.stdout)).toEqual(verifyLog);

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  // 20s readiness + 45s settle (implement + verify turns) + dashboard health
  // and stop, plus prepare() and daemon shutdown.
  240_000,
);

test.skipIf(!builtCli)(
  "GET /api/workspace serves the workspace structure with every secret redacted",
  async () => {
    const worker = new WorkerFixture();
    let dashboard: DashboardFixture | undefined;
    // Fake, non-routable credentials; none of them may reach a response.
    const remotePassword = `fake-remote-pass-${crypto.randomUUID()}`;
    const inlineToken = fakeGithubToken();
    const envFileToken = `fake-env-file-token-${crypto.randomUUID()}`;
    const sharedEnvSecret = `fake-shared-secret-${crypto.randomUUID()}`;
    const unquotedToken = fakeGithubToken();
    const secrets = [remotePassword, inlineToken, envFileToken, sharedEnvSecret, unquotedToken];
    try {
      // prepare() supplies the deterministic AGENT_CLI_PATH the CLI resolves
      // before dispatching `dashboard`; the worker itself is never started.
      await worker.prepare();
      const configPath = join(worker.workspaceDir, "workspace.toml");
      mkdirSync(join(worker.workspaceDir, "env"), { recursive: true });
      writeFileSync(
        join(worker.workspaceDir, "env", "svc.env"),
        `SVC_DEPLOY_TOKEN=${envFileToken}\nSVC_REGION=eu-e2e\n`,
      );
      writeFileSync(join(worker.workspaceDir, ".env"), `SHARED_SECRET=${sharedEnvSecret}\n`);
      writeFileSync(
        configPath,
        [
          "[defaults]",
          'tracker = "markdown"',
          "",
          "[[repos]]",
          'name = "svc"',
          `remote = "https://e2e-user:${remotePassword}@git.e2e.invalid/org/svc.git"`,
          'default_branch = "main"',
          'env_file = "env/svc.env"',
          "",
          "[repos.env]",
          `SVC_API_TOKEN = "${inlineToken}"`,
          'SVC_PLAIN = "visible-name-only"',
          "",
        ].join("\n"),
      );

      dashboard = await DashboardFixture.start(worker);
      const url = `${dashboard.baseUrl}/api/workspace`;

      // --- valid config: structure kept, values dropped -----------------------
      let response = await fetch(url);
      expect(response.status).toBe(200);
      let text = await response.text();
      expectNoSecret("workspace (ok)", text, secrets);
      // Env values are never inlined, even non-secret ones.
      expect(text).not.toContain("visible-name-only");
      expect(text).not.toContain("eu-e2e");
      const ok = JSON.parse(text) as WorkspaceBody;
      expect(ok.status).toBe("ok");
      expect(ok.configPath).toBe(configPath);
      expect(ok.config?.defaults.tracker).toBe("markdown");
      expect(ok.config?.repos).toEqual([
        {
          name: "svc",
          // Userinfo with a password is stripped from the URL entirely.
          remote: "https://git.e2e.invalid/org/svc.git",
          defaultBranch: "main",
          envFile: {
            path: "env/svc.env",
            resolvedPath: join(worker.workspaceDir, "env", "svc.env"),
            exists: true,
            keys: ["SVC_DEPLOY_TOKEN", "SVC_REGION"],
          },
          envKeys: ["SVC_API_TOKEN", "SVC_PLAIN"],
        },
      ]);
      expect(ok.config?.sharedEnv).toMatchObject({
        exists: true,
        keys: ["SHARED_SECRET"],
      });

      // --- invalid config: a syntax error never echoes the offending value ----
      writeFileSync(configPath, `[defaults]\ntracker = "markdown"\napi_token = ${unquotedToken}\n`);
      response = await fetch(url);
      expect(response.status).toBe(200);
      text = await response.text();
      expectNoSecret("workspace (syntax error)", text, secrets);
      const syntax = JSON.parse(text) as WorkspaceBody;
      expect(syntax.status).toBe("invalid");
      expect(syntax.error).toStartWith(`Failed to parse ${configPath}`);
      expect(syntax.config).toBeUndefined();

      // --- invalid config: validation problems drop URL credentials ----------
      writeFileSync(
        configPath,
        [
          "[defaults]",
          'tracker = "markdown"',
          "[[repos]]",
          'name = "svc"',
          `remote = "https://e2e-user:${remotePassword}@git.e2e.invalid/org/svc.git"`,
          "default_branch = 5",
          "",
        ].join("\n"),
      );
      response = await fetch(url);
      expect(response.status).toBe(200);
      text = await response.text();
      expectNoSecret("workspace (validation error)", text, secrets);
      expect(JSON.parse(text)).toMatchObject({
        status: "invalid",
        error: `Invalid ${configPath}`,
        problems: ["[[repos]][0].default_branch must be a non-empty string."],
      });

      // --- missing config: a typed state, not a 500 ---------------------------
      renameSync(configPath, `${configPath}.moved`);
      response = await fetch(url);
      expect(response.status).toBe(200);
      text = await response.text();
      expectNoSecret("workspace (missing)", text, secrets);
      const missing = JSON.parse(text) as WorkspaceBody;
      expect(missing.status).toBe("missing");
      expect(missing.error).toContain(`No workspace config at ${configPath}`);

      expect(await dashboard.stop()).toBe(0);
      dashboard = undefined;
    } finally {
      await dashboard?.stop().catch(() => undefined);
      await worker.dispose();
    }
  },
  60_000,
);
