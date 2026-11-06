import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureWorkspace, cliPath } from "../../helpers/fixture-workspace";
import { checkedCommand, command } from "../../helpers/process";
import { ReportServerFixture } from "../../helpers/report-server";

interface ReportPayload {
  schema: number;
  reportId: string;
  title: string;
  description: string;
  context?: {
    run?: {
      id?: number;
      taskKey?: string;
      status: string;
    };
    logs?: Array<{ source: string; text: string; lines: number }>;
  };
}

interface SpoolListEntry {
  id: string;
  status: string;
  url?: string;
}

interface SpoolEntry {
  status: string;
  error?: string;
  receipt?: string;
  url?: string;
  payload: ReportPayload;
}

const builtCli = existsSync(cliPath);
const repositorySlug = "example-owner/example-repo";
const githubToken = `ghp_${"A".repeat(30)}`;
const jiraToken = `jira_${"B".repeat(24)}`;
const urlPassword = "sup3rSecretPassword";
const contactEmail = "leaked-contact@example.test";

/** Parse a JSON document produced by the CLI. */
function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** Names of sensitive values that survived redaction. Never echo the values. */
function leakedNames(serialized: string, values: Array<[string, string]>): string[] {
  return values.filter(([, value]) => serialized.includes(value)).map(([name]) => name);
}

/** Assert the serialized payload contains no raw sensitive value. */
function expectNoLeaks(serialized: string, values: Array<[string, string]>, label: string): void {
  expect(leakedNames(serialized, values), `${label} leaked a sensitive value`).toEqual([]);
}

describe.skipIf(!builtCli)("devintern report", () => {
  let workspace: FixtureWorkspace;
  let logPath: string;

  /** Run the built report command from the fixture checkout. */
  function runReport(args: string[], timeout = 30_000) {
    const env: Record<string, string> = {
      ...workspace.env,
      // The CLI resolves the agent harness even for `report`; pin the same
      // inert fixture agent the task run used instead of the host's CLIs.
      AGENT_CLI_PATH: join(workspace.root, "bin/agent.ts"),
    };
    // The explicit --endpoint is the only destination: never inherit a
    // developer's report URL from the ambient environment.
    delete env.DEVINTERN_REPORT_URL;
    return command([process.execPath, cliPath, "report", ...args], workspace.cwd, env, timeout);
  }

  /** Create a redacted payload and return both the file and its parsed body. */
  async function savePayload(
    path: string,
    title: string,
    endpoint: string,
  ): Promise<{ path: string; payload: ReportPayload }> {
    const result = await runReport([
      "--title",
      title,
      "--body",
      "The deterministic E2E task failed.",
      "--last",
      "--log",
      logPath,
      "--save",
      path,
      "--endpoint",
      endpoint,
    ]);
    expect(result.exitCode, `--save failed: ${result.stderr}`).toBe(0);
    return { path, payload: parseJson<ReportPayload>(readFileSync(path, "utf8")) };
  }

  /** Sensitive values the default report must never contain. */
  function sensitiveValues(): Array<[string, string]> {
    return [
      ["GitHub token", githubToken],
      ["Jira token", jiraToken],
      ["URL password", urlPassword],
      ["absolute checkout path", workspace.cwd],
      ["isolated HOME path", workspace.env.HOME],
      ["repository slug", repositorySlug],
      ["task key", workspace.taskKey],
      ["contact email", contactEmail],
    ];
  }

  beforeAll(async () => {
    workspace = new FixtureWorkspace();
    try {
      const remote = join(workspace.root, "remote.git");
      await checkedCommand(["git", "init", "--bare", remote], workspace.root, workspace.env);
      await workspace.prepare(remote, "test-token", {});

      const failed = await workspace.runTask({ agentMode: "fail" });
      if (failed.exitCode === 0) {
        throw new Error("The fixture task was expected to fail but exited 0");
      }
      const records = workspace.runRecords();
      if (records.length !== 1 || records[0]?.status !== "failed") {
        throw new Error(`Expected one failed run record, got ${JSON.stringify(records)}`);
      }

      // The run used a local bare remote so no hosted API is involved. Point
      // origin at a realistic HTTPS URL afterwards: slug extraction only reads
      // git config, and the report never contacts the remote.
      await workspace.git(
        "remote",
        "set-url",
        "origin",
        `https://github.com/${repositorySlug}.git`,
      );

      logPath = join(workspace.root, "report-secrets.log");
      writeFileSync(
        logPath,
        [
          `github_token=${githubToken}`,
          `jira_token=${jiraToken}`,
          `remote=https://e2e-user:${urlPassword}@example.test/repository`,
          `repository=https://github.com/${repositorySlug}.git`,
          `task ${workspace.taskKey} failed`,
          `path=${workspace.cwd}/src/greeting.ts`,
          `home=${workspace.env.HOME}/.devintern-code/session.json`,
          `contact=${contactEmail}`,
          "",
        ].join("\n"),
      );
    } catch (error) {
      workspace.dispose();
      throw error;
    }
  }, 60_000);

  afterAll(() => {
    workspace?.dispose();
  });

  test("--print redacts credentials, paths, identifiers, and emails without a request", async () => {
    const server = await ReportServerFixture.start();
    try {
      const result = await runReport([
        "--title",
        "Run failed while implementing the fixture",
        "--body",
        "Expected a passing run, but the task failed.",
        "--last",
        "--log",
        logPath,
        "--print",
        "--endpoint",
        server.endpoint,
      ]);
      expect(result.exitCode, `--print failed: ${result.stderr}`).toBe(0);

      const payload = parseJson<ReportPayload>(result.stdout);
      expect(payload.schema).toBe(1);
      expect(payload.context?.run?.status).toBe("failed");

      const log = payload.context?.logs?.find((entry) => entry.source === "report-secrets.log");
      expect(log, "the requested log was not attached").toBeDefined();
      expect(log?.text).toContain("<repo>");
      expect(log?.text).toContain("<task>");
      expect(log?.text).toContain("<email>");
      expect(log?.text).toContain("[redacted]");

      expectNoLeaks(JSON.stringify(payload), sensitiveValues(), "default preview");
      expect(payload.context?.run?.taskKey).toBeUndefined();
      expect(server.requests).toHaveLength(0);
    } finally {
      server.dispose();
    }
  }, 30_000);

  test("--share-identifiers keeps the task key and repository slug but not secrets or paths", async () => {
    const server = await ReportServerFixture.start();
    try {
      const result = await runReport([
        "--title",
        "Share identifiers",
        "--body",
        "Include the task and repository for triage.",
        "--last",
        "--log",
        logPath,
        "--share-identifiers",
        "--print",
        "--endpoint",
        server.endpoint,
      ]);
      expect(result.exitCode, `--share-identifiers --print failed: ${result.stderr}`).toBe(0);

      const payload = parseJson<ReportPayload>(result.stdout);
      const serialized = JSON.stringify(payload);
      expect(serialized).toContain(workspace.taskKey);
      expect(serialized).toContain(repositorySlug);
      expect(payload.context?.run?.taskKey).toBe(workspace.taskKey);

      const stillSensitive = sensitiveValues().filter(
        ([name]) => name !== "repository slug" && name !== "task key",
      );
      expectNoLeaks(serialized, stillSensitive, "shared-identifier preview");
      expect(server.requests).toHaveLength(0);
    } finally {
      server.dispose();
    }
  }, 30_000);

  test("--save writes an owner-only payload without a request", async () => {
    const server = await ReportServerFixture.start();
    try {
      const savedPath = join(workspace.root, "saved-report.json");
      const saved = await savePayload(savedPath, "Saved report", server.endpoint);

      expect(statSync(savedPath).mode & 0o777).toBe(0o600);
      expect(saved.payload.context?.run?.status).toBe("failed");
      expectNoLeaks(JSON.stringify(saved.payload), sensitiveValues(), "saved payload");
      expect(server.requests).toHaveLength(0);
    } finally {
      server.dispose();
    }
  }, 30_000);

  test("--from posts the saved payload and records a submitted spool entry", async () => {
    const server = await ReportServerFixture.start();
    try {
      server.respond(201, {
        id: "receipt-1",
        url: "https://devintern.test/reports/receipt-1",
        receipt: "receipt-1",
      });
      const savedPath = join(workspace.root, "submit-report.json");
      const saved = await savePayload(savedPath, "Submitted report", server.endpoint);

      const submit = await runReport([
        "--from",
        savedPath,
        "--endpoint",
        server.endpoint,
        "--yes",
        "--json",
      ]);
      expect(submit.exitCode, `--from failed: ${submit.stderr}`).toBe(0);
      const receipt = parseJson<{ ok: boolean; id: string; receipt?: string }>(submit.stdout);
      expect(receipt.ok).toBe(true);
      expect(receipt.id).toBe("receipt-1");
      expect(receipt.receipt).toBe("receipt-1");

      expect(server.requests).toHaveLength(1);
      expect(parseJson<ReportPayload>(server.requests[0]!.body)).toEqual(saved.payload);

      const list = await runReport(["list", "--json"]);
      expect(list.exitCode).toBe(0);
      const listed = parseJson<SpoolListEntry[]>(list.stdout).find(
        (entry) => entry.id === saved.payload.reportId,
      );
      expect(listed).toMatchObject({
        id: saved.payload.reportId,
        status: "submitted",
        url: "https://devintern.test/reports/receipt-1",
      });

      const show = await runReport(["show", saved.payload.reportId, "--json"]);
      expect(show.exitCode).toBe(0);
      const entry = parseJson<SpoolEntry>(show.stdout);
      expect(entry.status).toBe("submitted");
      expect(entry.receipt).toBe("receipt-1");
    } finally {
      server.dispose();
    }
  }, 30_000);

  test("a rejected submission is spooled with its error and can be retried with --from", async () => {
    const server = await ReportServerFixture.start();
    try {
      const savedPath = join(workspace.root, "rejected-report.json");
      const saved = await savePayload(savedPath, "Rejected report", server.endpoint);

      server.respond(500, { error: "simulated rejection" });
      const rejected = await runReport([
        "--from",
        savedPath,
        "--endpoint",
        server.endpoint,
        "--yes",
        "--json",
      ]);
      expect(rejected.exitCode).not.toBe(0);
      const failure = parseJson<{ ok: boolean; error: string; savedPath: string }>(rejected.stdout);
      expect(failure.ok).toBe(false);
      expect(failure.error).toContain("500");
      expect(failure.error).toContain("simulated rejection");
      expect(existsSync(failure.savedPath)).toBe(true);

      const list = await runReport(["list", "--json"]);
      expect(list.exitCode).toBe(0);
      const listed = parseJson<SpoolListEntry[]>(list.stdout).find(
        (entry) => entry.id === saved.payload.reportId,
      );
      expect(listed?.status).toBe("pending");

      const show = await runReport(["show", saved.payload.reportId, "--json"]);
      expect(show.exitCode).toBe(0);
      const entry = parseJson<SpoolEntry>(show.stdout);
      expect(entry.status).toBe("pending");
      expect(entry.error).toContain("simulated rejection");

      server.respond(200, {
        id: "retry-receipt",
        url: "https://devintern.test/reports/retry-receipt",
        receipt: "retry-receipt",
      });
      const retry = await runReport([
        "--from",
        savedPath,
        "--endpoint",
        server.endpoint,
        "--yes",
        "--json",
      ]);
      expect(retry.exitCode, `retry failed: ${retry.stderr}`).toBe(0);
      const receipt = parseJson<{ ok: boolean; id: string }>(retry.stdout);
      expect(receipt.ok).toBe(true);
      expect(receipt.id).toBe("retry-receipt");
      expect(server.requests).toHaveLength(2);

      const showAfterRetry = await runReport(["show", saved.payload.reportId, "--json"]);
      expect(showAfterRetry.exitCode).toBe(0);
      const retried = parseJson<SpoolEntry>(showAfterRetry.stdout);
      expect(retried.status).toBe("submitted");
      expect(retried.receipt).toBe("retry-receipt");
      expect(retried.error).toBeUndefined();
    } finally {
      server.dispose();
    }
  }, 30_000);

  test("missing input and missing confirmation exit 2 without sending", async () => {
    const server = await ReportServerFixture.start();
    try {
      const missingTitle = await runReport(["--body", "No title", "--print"]);
      expect(missingTitle.exitCode).toBe(2);
      expect(missingTitle.stderr).toContain("title is required");

      const missingDescription = await runReport(["--title", "No description", "--print"]);
      expect(missingDescription.exitCode).toBe(2);
      expect(missingDescription.stderr).toContain("description is required");

      const savedPath = join(workspace.root, "confirmation-report.json");
      const saved = await savePayload(savedPath, "Needs confirmation", server.endpoint);
      const noConfirmation = await runReport([
        "--from",
        savedPath,
        "--endpoint",
        server.endpoint,
        "--json",
      ]);
      expect(noConfirmation.exitCode).toBe(2);
      expect(noConfirmation.stderr).toContain("Refusing to submit without confirmation");
      expect(saved.payload.reportId).toBeTruthy();
      expect(server.requests).toHaveLength(0);
    } finally {
      server.dispose();
    }
  }, 30_000);
});
