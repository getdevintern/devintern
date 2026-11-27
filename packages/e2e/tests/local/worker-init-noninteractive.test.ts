/**
 * `devintern worker init --non-interactive`: the flag-driven, prompt-free
 * worker setup, fully offline.
 *
 * The built CLI runs with stdin closed and no TTY against a Markdown task
 * folder and a checkout whose `origin` is a local bare repository, so the
 * tracker, repository-access, and query checks all run for real without a
 * network or credentials. PATH holds only `git`, `bun`, and (when a test
 * wants it) a stub `claude` CLI; see `helpers/worker-init.ts`.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";
import type { CommandResult } from "../../helpers/process";
import {
  STACK_TRACE_PATTERNS,
  WorkerInitFixture,
  outputLines,
  parseReport,
} from "../../helpers/worker-init";

const cliTest = test.skipIf(!existsSync(cliPath));

async function withFixture(
  run: (fixture: WorkerInitFixture) => Promise<void>,
  options?: ConstructorParameters<typeof WorkerInitFixture>[0],
): Promise<void> {
  const fixture = new WorkerInitFixture(options);
  try {
    await fixture.seedRepository();
    await run(fixture);
  } finally {
    fixture.release();
  }
}

function expectNoStackTrace(result: CommandResult): void {
  for (const pattern of STACK_TRACE_PATTERNS) {
    expect(result.stdout).not.toMatch(pattern);
    expect(result.stderr).not.toMatch(pattern);
  }
}

/** One `❌` line on stderr, nothing on stdout, exit 1, no workspace files. */
function expectInputError(
  fixture: WorkerInitFixture,
  result: CommandResult,
  message: string,
): void {
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.stdout).toBe("");
  const lines = outputLines(result.stderr);
  expect(lines.filter((line) => line.startsWith("❌"))).toEqual([expect.stringContaining(message)]);
  expect(lines[0]).toStartWith("❌");
  expectNoStackTrace(result);
  expect(fixture.workspaceFiles()).toEqual([]);
}

cliTest(
  "worker init --non-interactive: markdown happy path writes the workspace and doctor agrees",
  async () => {
    await withFixture(async (fixture) => {
      const result = await fixture.init(["--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expectNoStackTrace(result);

      // stdout is exactly one JSON document (JSON.parse rejects trailing text).
      const report = parseReport(result.stdout);
      expect(report).toMatchObject({
        schema: "devintern.worker-init",
        version: 1,
        result: "success",
        workspaceDir: fixture.workspaceDir,
        tracker: "markdown",
        taskQuery: "status=todo",
        repo: { name: "acme-app", remote: fixture.remoteDir, added: true },
      });
      expect(report.error).toBeUndefined();
      expect([...report.filesWritten].sort()).toEqual([fixture.envPath, fixture.configPath]);
      const checks = Object.fromEntries(report.checks.map((check) => [check.name, check]));
      expect(checks.query).toMatchObject({ status: "pass" });
      expect(checks.query!.message).toContain("1 task matches");
      expect(checks.repo).toMatchObject({ status: "pass" });
      expect(checks.repo!.message).toContain("remote reachable");
      expect(checks.harness).toMatchObject({ status: "pass" });
      expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
      // Never started here: the background service stays a next step.
      expect(report.nextSteps.map((step) => step.id)).toContain("service");

      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(fixture.envPath, "utf8")).toContain(
        `MARKDOWN_TASKS_DIR=${fixture.tasksDir}`,
      );
      const config = fixture.config();
      expect(config.defaults).toMatchObject({ tracker: "markdown", task_query: "status=todo" });
      expect(config.repos).toEqual([
        expect.objectContaining({ name: "acme-app", remote: fixture.remoteDir }),
      ]);

      // Init never starts or installs anything.
      expect(fixture.workspaceFiles()).not.toContain("devintern-worker.service");

      // A follow-up doctor reads the same files and reaches the same verdict.
      const doctor = await fixture.run(["worker", "doctor"]);
      expect(doctor.exitCode, doctor.stdout).toBe(0);
      expect(doctor.stdout).toContain("✅ Tracker credentials — markdown ([defaults])");
      expect(doctor.stdout).toContain("✅ Task query — markdown ([defaults]): 1 task matches");
      expect(doctor.stdout).toContain(
        `✅ Repository access — [[repos]] "acme-app" (${fixture.remoteDir}): remote reachable`,
      );
      expect(doctor.stdout).toContain("✅ Agent harness — claude-code");
      expect(doctor.stdout).not.toContain("❌");
    });
  },
  180_000,
);

cliTest(
  "worker init --non-interactive: text mode prints the report and next steps on stdout",
  async () => {
    await withFixture(async (fixture) => {
      const result = await fixture.init();
      expect(result.exitCode, result.stderr).toBe(0);
      expectNoStackTrace(result);
      expect(result.stdout).toContain("1 task matches");
      expect(result.stdout).toContain("devintern worker");
      expect(() => JSON.parse(result.stdout)).toThrow();
      expect(fixture.config().defaults?.tracker).toBe("markdown");
    });
  },
  180_000,
);

cliTest(
  "worker init --non-interactive: a query with 0 matches is a warning, not a failure",
  async () => {
    await withFixture(
      async (fixture) => {
        const result = await fixture.init(["--json"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const report = parseReport(result.stdout);
        expect(report.result).toBe("success");
        const query = report.checks.find((check) => check.name === "query");
        expect(query).toMatchObject({ status: "warn" });
        expect(query!.message).toContain("0 tasks match");
        expect(query!.hint).toContain("matches nothing");
      },
      { tasks: 0 },
    );
  },
  180_000,
);

cliTest(
  "worker init --non-interactive: no agent CLI on PATH fails the harness check with exit 1",
  async () => {
    await withFixture(
      async (fixture) => {
        const result = await fixture.init(["--json"]);
        expect(result.exitCode, result.stdout).toBe(1);
        expectNoStackTrace(result);
        const report = parseReport(result.stdout);
        expect(report.result).toBe("failure");
        // The checks ran (no input error); only the harness fails.
        expect(report.error).toBeUndefined();
        const failed = report.checks.filter((check) => check.status === "fail");
        expect(failed.map((check) => check.name)).toEqual(["harness"]);
        expect(failed[0]!.message).toContain('Harness "claude-code" is not installed');
        expect(failed[0]!.hint).toContain("AGENT_HARNESS");
      },
      { agent: false },
    );
  },
  180_000,
);

cliTest(
  "worker init --non-interactive: input errors write nothing and exit 1 with one line",
  async () => {
    await withFixture(async (fixture) => {
      // Missing flags, text mode: every missing flag and variable in one line.
      // Jira has a default query (open tickets labeled `devintern`), so
      // `--task-query` is not among them.
      expectInputError(
        fixture,
        await fixture.run(["worker", "init", "--non-interactive", "--tracker", "jira"]),
        "missing: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.",
      );

      // Missing flags, JSON mode: the error is in the document, stderr stays empty.
      const missingJson = await fixture.run(["worker", "init", "--non-interactive", "--json"]);
      expect(missingJson.exitCode).toBe(1);
      expect(missingJson.stderr).toBe("");
      const missingReport = parseReport(missingJson.stdout);
      expect(missingReport).toMatchObject({
        schema: "devintern.worker-init",
        version: 1,
        result: "failure",
        tracker: null,
        filesWritten: [],
        checks: [],
      });
      expect(missingReport.error).toStartWith("missing: --tracker, --task-query.");
      expect(fixture.workspaceFiles()).toEqual([]);

      // A secret-looking flag is refused without echoing its value.
      const secretValue = `e2e-flag-secret-${crypto.randomUUID()}`;
      const secretFlag = await fixture.run([
        "worker",
        "init",
        "--non-interactive",
        "--tracker",
        "jira",
        "--task-query",
        "project = DEV",
        "--jira-token",
        secretValue,
      ]);
      expectInputError(fixture, secretFlag, "Unknown option: --jira-token.");
      expect(secretFlag.stderr).toContain("Secrets are never accepted as flags");
      expect(secretFlag.stderr).not.toContain(secretValue);

      // Unsupported tracker (JSON).
      const tracker = await fixture.run([
        "worker",
        "init",
        "--non-interactive",
        "--tracker",
        "youtrack",
        "--task-query",
        "x",
        "--json",
      ]);
      expect(tracker.exitCode).toBe(1);
      expect(parseReport(tracker.stdout).error).toStartWith(
        'Unsupported --tracker "youtrack". Supported trackers: jira,',
      );
      expect(fixture.workspaceFiles()).toEqual([]);
      // ...and in text mode.
      expectInputError(
        fixture,
        await fixture.run([
          "worker",
          "init",
          "--non-interactive",
          "--tracker",
          "youtrack",
          "--task-query",
          "x",
        ]),
        'Unsupported --tracker "youtrack".',
      );

      // An --env-file readable by others is refused before it is read.
      const envFile = join(fixture.root, "creds.env");
      const fileSecret = `e2e-envfile-secret-${crypto.randomUUID()}`;
      writeFileSync(
        envFile,
        `JIRA_BASE_URL=https://jira.invalid\nJIRA_EMAIL=bot@example.invalid\nJIRA_API_TOKEN=${fileSecret}\n`,
      );
      chmodSync(envFile, 0o644);
      const loose = await fixture.run([
        "worker",
        "init",
        "--non-interactive",
        "--tracker",
        "jira",
        "--task-query",
        "project = DEV",
        "--env-file",
        envFile,
      ]);
      expectInputError(
        fixture,
        loose,
        `Refusing to read --env-file ${envFile}: mode 0644 lets group or others read it. Fix: chmod 600 ${envFile}`,
      );
      expect(loose.stderr).not.toContain(fileSecret);

      // --repo-from-cwd outside a git repository.
      const plain = join(fixture.root, "plain");
      mkdirSync(plain);
      expectInputError(
        fixture,
        await fixture.init([], { cwd: plain }),
        `--repo-from-cwd: ${plain} is not inside a git repository.`,
      );

      // --repo-from-cwd in a checkout without an origin remote.
      const noOrigin = join(fixture.root, "no-origin");
      mkdirSync(noOrigin);
      await checkedCommand(["git", "init", "--initial-branch", "main"], noOrigin, fixture.env);
      expectInputError(
        fixture,
        await fixture.init([], { cwd: noOrigin }),
        `--repo-from-cwd: ${noOrigin} has no origin remote.`,
      );

      // Non-interactive flags without --non-interactive.
      expectInputError(
        fixture,
        await fixture.run(["worker", "init", "--yes", "--json"]),
        "--yes needs --non-interactive.",
      );
      expectInputError(
        fixture,
        await fixture.run(["worker", "init", "--tracker", "markdown"]),
        "--tracker needs --non-interactive.",
      );
    });
  },
  240_000,
);

cliTest(
  "worker init --non-interactive: an existing workspace is refused without --yes, and --yes updates only the query",
  async () => {
    await withFixture(async (fixture) => {
      const first = await fixture.init(["--json"]);
      expect(first.exitCode, first.stderr).toBe(0);
      const configBefore = readFileSync(fixture.configPath, "utf8");
      const envBefore = fixture.hash(fixture.envPath);

      // Without --yes: refused, one line, nothing changes.
      const refused = await fixture.init([], { query: "status=ready" });
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toBe("");
      expect(outputLines(refused.stderr)).toEqual([
        `❌ ${fixture.configPath} already exists with other settings; nothing was changed. Pass --yes to update its tracker, task_query, and repository entries (all other settings are kept).`,
        expect.stringContaining("--task-query 'status=ready' --repo-from-cwd --yes --json"),
      ]);
      expect(readFileSync(fixture.configPath, "utf8")).toBe(configBefore);
      expect(fixture.hash(fixture.envPath)).toBe(envBefore);

      // With --yes and only a new query: just task_query changes.
      const updated = await fixture.init(["--yes", "--json"], { query: "status=ready" });
      expect(updated.exitCode, updated.stderr).toBe(0);
      const report = parseReport(updated.stdout);
      expect(report).toMatchObject({
        result: "success",
        tracker: "markdown",
        taskQuery: "status=ready",
        repo: { name: "acme-app", added: false },
        filesWritten: [fixture.configPath],
      });
      const configAfter = readFileSync(fixture.configPath, "utf8");
      expect(configAfter).toBe(
        configBefore.replace('task_query = "status=todo"', 'task_query = "status=ready"'),
      );
      expect(configAfter).not.toBe(configBefore);
      expect(fixture.config().repos).toHaveLength(1);
      expect(fixture.hash(fixture.envPath)).toBe(envBefore);
    });
  },
  240_000,
);

cliTest(
  "worker init --non-interactive: concurrent runs write once and register one repo",
  async () => {
    await withFixture(async (fixture) => {
      const runs = await Promise.all([1, 2, 3].map(() => fixture.init(["--json"])));
      const reports = runs.map((run) => parseReport(run.stdout));
      const writers = reports.filter((report) => report.filesWritten.length > 0);
      expect(writers).toHaveLength(1);
      expect(writers[0]!.error).toBeUndefined();
      expect(writers[0]!.result).toBe("success");
      const others = runs
        .map((run, index) => ({ run, report: reports[index]! }))
        .filter(({ report }) => report.filesWritten.length === 0);
      expect(others).toHaveLength(2);
      for (const { run, report } of others) {
        if (report.result === "unchanged") {
          // Started after the winner saved the same config: a no-op (exit 0).
          expect(report.error).toBeUndefined();
          expect(run.exitCode).toBe(0);
          continue;
        }
        // Otherwise the write lock was held while the winner was writing.
        expect(report.result).toBe("failure");
        expect(report.checks).toEqual([]);
        expect(report.error).toMatch(/already exists|being modified|another|in progress|lock/i);
        expect(run.exitCode).toBe(1);
      }
      const config = readFileSync(fixture.configPath, "utf8");
      expect(config.match(/^\[\[repos\]\]$/gm)).toHaveLength(1);
      expect(fixture.config().repos).toHaveLength(1);
    });
  },
  240_000,
);

cliTest(
  "worker init without a TTY points to --non-interactive and writes nothing",
  async () => {
    await withFixture(async (fixture) => {
      const result = await fixture.run(["worker", "init"]);
      expect(result.exitCode).toBe(1);
      expectNoStackTrace(result);
      const output = result.stdout + result.stderr;
      expect(output).toContain("❌ 'devintern worker init' needs a terminal for its prompts.");
      expect(output).toContain(
        'devintern worker init --non-interactive --tracker jira --task-query "<query>" --repo-from-cwd',
      );
      expect(fixture.workspaceFiles()).toEqual([]);
    });
  },
  120_000,
);

cliTest(
  "worker init --non-interactive: --env-file secrets never reach stdout or stderr",
  async () => {
    await withFixture(async (fixture) => {
      const token = `ghp_e2eInitSecret${crypto.randomUUID().replaceAll("-", "")}`;
      const licenseKey = `E2E-LICENSE-${crypto.randomUUID()}`;
      const envFile = join(fixture.root, "creds.env");
      writeFileSync(
        envFile,
        [
          `export GITHUB_TOKEN="${token}"`,
          `LICENSE_KEY=${licenseKey}`,
          `MARKDOWN_TASKS_DIR=${fixture.tasksDir}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      chmodSync(envFile, 0o600);
      const expectRedacted = (result: CommandResult) => {
        for (const secret of [token, licenseKey]) {
          for (const output of [result.stdout, result.stderr]) {
            expect(output).not.toContain(secret);
            expect(output).not.toContain(encodeURIComponent(secret));
          }
        }
      };

      const args = [
        "worker",
        "init",
        "--non-interactive",
        "--tracker",
        "markdown",
        "--task-query",
        "status=todo",
        "--repo-from-cwd",
        "--env-file",
        envFile,
      ];
      const json = await fixture.run([...args, "--json"]);
      expectRedacted(json);
      expect(json.exitCode, json.stderr).toBe(0);
      expect(parseReport(json.stdout).result).toBe("success");
      // The secrets reached the workspace .env (mode 0600), just never the terminal.
      const saved = readFileSync(fixture.envPath, "utf8");
      expect(saved).toContain(token);
      expect(saved).toContain(licenseKey);
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);

      const text = await fixture.run([...args, "--yes"]);
      expectRedacted(text);
      expect(text.exitCode, text.stderr).toBe(0);
      expectRedacted(await fixture.run(["worker", "doctor"]));
    });
  },
  240_000,
);

cliTest(
  "worker init --non-interactive: no sign-in yet is action_required (exit 2) in init and doctor alike, and a skipped check passes",
  async () => {
    await withFixture(async (fixture) => {
      // Licensing on, with no LICENSE_KEY or session in the temp HOME: nothing
      // is broken; signing in to start the Worker Pilot is the one step left.
      const licensing = { DEVINTERN_SKIP_LICENSE_CHECK: "0" };
      const init = await fixture.init(["--json"], { env: licensing });
      expect(init.exitCode, init.stdout + init.stderr).toBe(2);
      const report = parseReport(init.stdout);
      expect(report.result).toBe("action_required");
      const entitlement = report.checks.find((check) => /entitlement/i.test(check.label));
      expect(entitlement, init.stdout).toMatchObject({
        status: "action",
        message: "Not started: sign in to begin your 14-day free Worker Pilot, no card required",
      });
      expect(report.nextSteps[0]?.id).toBe("sign-in");
      expect(report.nextSteps[0]?.command).toMatch(
        /^devintern worker login( --workspace \S+)? github --no-wait --json$/,
      );
      expectNoStackTrace(init);
      // The setup is kept, so doctor has a workspace to judge.
      expect(fixture.config().defaults).toMatchObject({ tracker: "markdown" });

      const doctor = await fixture.run(["worker", "doctor"], { env: licensing });
      expect(doctor.exitCode, doctor.stdout + doctor.stderr).toBe(2);
      expect(doctor.stdout).toMatch(/👉 Automation entitlement — Not started/);
      expect(doctor.stdout).not.toMatch(/❌ Automation entitlement/);

      // With the check skipped, doctor passes on the same workspace.
      const skipped = await fixture.run(["worker", "doctor"], {
        env: { DEVINTERN_SKIP_LICENSE_CHECK: "1" },
      });
      expect(skipped.exitCode, skipped.stdout + skipped.stderr).toBe(0);
    });
  },
  120_000,
);
