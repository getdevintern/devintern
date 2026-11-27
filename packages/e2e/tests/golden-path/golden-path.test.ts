/**
 * Onboarding golden path, end to end on a blank box (opt-in:
 * `test:e2e:golden-path`; needs Docker, network, and a GitHub fixture token).
 *
 * One fresh systemd container per run. Everything a user would type runs
 * through `docker exec -u <user>` with no TTY, stdin closed, and a login shell
 * (`bash -l`): no injected PATH, git identity, XDG_RUNTIME_DIR or bus address.
 * The steps run in order and each one stops the rest when it fails, so the
 * first `(fail)` line names the broken onboarding step:
 *
 * 1. Install the CLI with `bun add -g` (packed tarball or the npm release) and
 *    find `devintern` on a new login shell's PATH.
 * 2. `worker init --non-interactive --tracker github ... --env-file --json`
 *    on a checkout of a unique base branch of the fixture repository.
 * 3. `worker doctor --json`.
 * 4. `worker service install --json`, then `service status --json`.
 * 5. A labelled issue is picked up by the service worker, which opens the PR.
 * 6. `service stop`, `restart`, `uninstall`.
 * 7. The interactive wizard on a PTY for a second, untouched user.
 *
 * Source mode (a packed local build) stands in for sign-in with
 * DEVINTERN_SKIP_LICENSE_CHECK. Release mode (`DEVINTERN_CLI_SOURCE=npm:...`)
 * installs the published package, where that flag is ignored, so it first
 * asserts that sign-in stays the one step left (doctor `action_required`,
 * service install refused). With E2E_LICENSE_KEY set it then writes that key
 * to the workspace `.env`, as a paying user would, and runs steps 3 to 6 like
 * source mode; without it those steps are skipped.
 *
 * Every GitHub resource is unique to the run and removed in `afterAll`: the
 * issue is closed, the PR closed, both branches and the trigger label deleted.
 * The shared status labels are created when missing and kept, like the other
 * live suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { collectGitHubCleanupFailures, throwCleanupFailures } from "../../helpers/cleanup";
import type { CleanupFailure } from "../../helpers/cleanup";
import { redact } from "../../helpers/github-worker";
import type { CommandResult } from "../../helpers/process";
import { PtySession, ptyAvailable } from "../../helpers/pty";
import { SystemdContainer } from "../../helpers/systemd-container";
import { IMPLEMENTATION_COMMENT_MARKER } from "../../helpers/tracker-lifecycle";
import { TRACKER_STATUS_SETTINGS, TRACKER_UNRELATED_LABEL } from "../../helpers/tracker-scenario";
import type { WorkerInitReport } from "../../helpers/worker-init";
import { GitHub } from "../../providers/github";
import { GitHubTracker } from "../../providers/github-tracker";

const enabled = process.env.DEVINTERN_E2E_GOLDEN_PATH === "1";
const tarball = process.env.E2E_GOLDEN_CLI_TARBALL;
const npmSpec = process.env.E2E_GOLDEN_CLI_NPM_SPEC;
/** A release build (the npm package) ignores DEVINTERN_SKIP_LICENSE_CHECK. */
const releaseBuild = process.env.E2E_GOLDEN_RELEASE_BUILD === "1";
/**
 * A paid LICENSE_KEY for release mode (CI secret E2E_LICENSE_KEY). With it a
 * release build runs the full path to a PR; without it those steps skip.
 * Source mode ignores it and keeps the skip flag.
 */
const licenseKey = releaseBuild ? (process.env.E2E_LICENSE_KEY?.trim() ?? "") : "";
/** Steps that need a licensed worker: source mode, or release mode with a key. */
const fullPath = !releaseBuild || licenseKey !== "";
const expectedVersion = process.env.E2E_GOLDEN_CLI_VERSION ?? "";
const repository = process.env.E2E_GITHUB_REPOSITORY ?? "";
const token = process.env.E2E_GITHUB_TOKEN ?? "";

const USER = "tester";
const HOME = `/home/${USER}`;
const WORKSPACE = `${HOME}/.devintern`;
const UNIT = `${HOME}/.config/systemd/user/devintern-worker.service`;
const ENV_FILE = `${HOME}/devintern.env`;
const AGENT_LOG = `${HOME}/agent-invocations.jsonl`;
const NEWCOMER = "newcomer";

const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const BASE = `e2e/golden-${runId}`;
/** Unique per run, so the worker's query only ever matches this run's issue. */
const TRIGGER_LABEL = `e2e-golden-${runId}`;
const TASK_QUERY = `is:open label:${TRIGGER_LABEL}`;
const STATUS_LABELS = Object.values(TRACKER_STATUS_SETTINGS);

/** How long the service worker gets to find the issue and open its PR. */
const PR_TIMEOUT_MS = 300_000;

interface ReportCheck {
  name: string;
  status: string;
  message: string;
}

interface DoctorReport {
  schema: string;
  version: number;
  result: string;
  /** Done signal: complete, ready, action_required, or not_ready. */
  setup: string;
  summary: string;
  checks: ReportCheck[];
  nextSteps: NextStep[];
}

/** The shared next-step shape of init, doctor and service documents. */
interface NextStep {
  id: string;
  message: string;
  command: string;
  url?: string;
}

interface ServiceDoc {
  schema: string;
  action: string;
  result: string;
  error?: string;
  unchanged?: boolean;
  start?: { state: string; pid?: number; reason?: string };
  checks?: ReportCheck[];
  service?: { state: string; installed: boolean; worker: { status: string } };
  nextSteps: NextStep[];
}

describe.skipIf(!enabled)("onboarding golden path", () => {
  const container = new SystemdContainer({
    image: process.env.E2E_GOLDEN_IMAGE,
    namePrefix: "devintern-e2e-golden",
  });
  const github = new GitHub(repository || "unset/unset", token || "unset");
  const tracker = new GitHubTracker(repository || "unset/unset", token || "unset", STATUS_LABELS);
  const ownedBranches = new Set<string>();
  const ownedIssues: string[] = [];
  let labelCreated = false;
  let failedStep: string | undefined;

  /**
   * One golden-path step. After a step fails the dependent steps fail at once
   * naming it, instead of each waiting out its own timeout.
   */
  function step(
    name: string,
    run: () => Promise<void>,
    options: { timeout?: number; independent?: boolean; skip?: boolean } = {},
  ): void {
    test.skipIf(options.skip === true)(
      name,
      async () => {
        if (failedStep && !options.independent) {
          throw new Error(`Not run: the earlier step "${failedStep}" failed`);
        }
        try {
          await run();
        } catch (error) {
          failedStep ??= name;
          const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
          throw new Error(redact(redact(`${detail}\n${await diagnostics()}`, token), licenseKey));
        }
      },
      options.timeout ?? 240_000,
    );
  }

  /** Worker journal and log tails for a failure report. */
  async function diagnostics(): Promise<string> {
    const logs = await container.user(
      `tail -n 40 ${WORKSPACE}/worker.stderr.log ${WORKSPACE}/worker.stdout.log 2>/dev/null || true`,
    );
    return `--- worker journal ---\n${await container.journal()}\n--- worker logs ---\n${logs.stdout}`;
  }

  /** Run a script as `tester` from a login shell; stdin closed, no TTY. */
  function sh(script: string, timeout?: number): Promise<CommandResult> {
    return container.login(USER, script, timeout);
  }

  async function checked(script: string, timeout?: number): Promise<string> {
    const result = await sh(script, timeout);
    if (result.exitCode !== 0) {
      throw new Error(
        `command failed (${result.exitCode}): ${script}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result.stdout;
  }

  /** Run a `devintern ... --json` command and parse its one JSON document. */
  async function json<T>(
    command: string,
    cwd = HOME,
    timeout = 180_000,
  ): Promise<{ exitCode: number; doc: T; stderr: string }> {
    const result = await sh(`cd ${cwd} && devintern ${command} --json </dev/null`, timeout);
    try {
      return {
        exitCode: result.exitCode,
        doc: JSON.parse(result.stdout) as T,
        stderr: result.stderr,
      };
    } catch {
      throw new Error(
        `devintern ${command} printed no JSON document (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`,
      );
    }
  }

  function unitProperty(name: string): Promise<string> {
    return container.unitProperty(name);
  }

  async function installCli(user: string): Promise<void> {
    const target = tarball ? "/tmp/cli.tgz" : npmSpec!;
    const install = await container.login(user, `bun add -g ${target} </dev/null 2>&1`, 300_000);
    expect(install.exitCode, install.stdout + install.stderr).toBe(0);
  }

  beforeAll(async () => {
    if (!repository || !token || (!tarball && !npmSpec)) {
      throw new Error(
        "Run through `bun run --filter @devintern/e2e test:e2e:golden-path`, which resolves the CLI and the GitHub fixture",
      );
    }
    await github.assertWritable();
    await container.start();
    if (tarball) await container.copyIn(tarball, "/tmp/cli.tgz");
  }, 300_000);

  afterAll(async () => {
    const failures: CleanupFailure[] = [];
    for (const key of ownedIssues) {
      try {
        await tracker.closeTicket(key);
      } catch (error) {
        failures.push({ resource: `issue:#${key}`, error });
      }
    }
    failures.push(...(await collectGitHubCleanupFailures(github, ownedBranches, BASE)));
    if (labelCreated) {
      try {
        await github.request(`/labels/${encodeURIComponent(TRIGGER_LABEL)}`, "DELETE");
      } catch (error) {
        failures.push({ resource: `label:${TRIGGER_LABEL}`, error });
      }
    }
    try {
      await container.dispose();
    } catch (error) {
      failures.push({ resource: `container:${container.name}`, error });
    }
    throwCleanupFailures(`Golden path cleanup failed for run ${runId}`, failures);
  }, 180_000);

  step("install: bun add -g from a login shell puts devintern on PATH", async () => {
    await installCli(USER);
    // A new login shell, like the next command a user types.
    const found = await checked("command -v devintern && devintern --version </dev/null");
    expect(found.trim().split("\n")).toEqual([`${HOME}/.bun/bin/devintern`, expectedVersion]);
    // A fresh host: no git identity or credential helper anywhere.
    expect(await sh("test -e ~/.gitconfig")).toMatchObject({ exitCode: 1 });
    expect(await sh("git config --get user.email")).toMatchObject({ exitCode: 1 });
  });

  step(
    "setup: clone a unique base branch of the fixture repository",
    async () => {
      await seedBaseBranch();
      await tracker.ensureLabels([...STATUS_LABELS, TRACKER_UNRELATED_LABEL]);
      await github.request("/labels", "POST", { name: TRIGGER_LABEL, color: "ededed" });
      labelCreated = true;
      // The deterministic agent stands in for Claude Code, installed where a
      // global agent CLI install lands on the user's profile PATH. It records
      // each invocation (E2E_AGENT_INVOCATIONS) so the test can count them.
      await checked("mkdir -p ~/.local/bin && ln -s /opt/e2e/fake-agent.ts ~/.local/bin/claude");
      expect((await checked("command -v claude")).trim()).toBe(`${HOME}/.local/bin/claude`);
      // The credentials file a user (or provisioning script) hands to init.
      await container.writePrivateFile(
        USER,
        ENV_FILE,
        [
          `GITHUB_TOKEN=${token}`,
          `GITHUB_STATUS_LABELS=${STATUS_LABELS.join(",")}`,
          `E2E_AGENT_INVOCATIONS=${AGENT_LOG}`,
          "AGENT_SANDBOX=none",
          "DEVINTERN_TELEMETRY_DISABLED=1",
          "DEVINTERN_NO_UPDATE=1",
          "SENTRY_DISABLED=1",
          "",
        ].join("\n"),
      );
      // The user's own clone. A one-off credential helper reads the token from
      // the file for this command only; no git config is written, so the
      // worker has to bring its own credentials later.
      await checked(
        `set -a; . ${ENV_FILE}; set +a; git -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' clone -q -b ${BASE} https://github.com/${repository}.git ~/app </dev/null`,
      );
      expect(await sh("test -e ~/.gitconfig")).toMatchObject({ exitCode: 1 });
    },
    { timeout: 120_000 },
  );

  step("worker init --non-interactive: saved, and sign-in is the one step left", async () => {
    const { exitCode, doc } = await json<WorkerInitReport>(
      `worker init --non-interactive --tracker github --task-query '${TASK_QUERY}' --repo-from-cwd --env-file ${ENV_FILE}`,
      `${HOME}/app`,
    );
    const shown = JSON.stringify(doc, null, 2);
    expect(doc.schema, shown).toBe("devintern.worker-init");
    expect(doc.version).toBe(1);
    expect(doc.result, shown).toBe("action_required");
    expect(exitCode, shown).toBe(2);
    expect(doc.error).toBeUndefined();
    expect(doc.workspaceDir).toBe(WORKSPACE);
    expect(doc.tracker).toBe("github");
    expect(doc.taskQuery).toBe(TASK_QUERY);
    expect(doc.repo).toMatchObject({ remote: `https://github.com/${repository}.git`, added: true });
    expect([...doc.filesWritten].sort()).toEqual([
      `${WORKSPACE}/.env`,
      `${WORKSPACE}/workspace.toml`,
    ]);
    // Nothing is broken: the only open item is signing in, and it comes first.
    expect(
      doc.checks.filter((check) => check.status === "fail"),
      shown,
    ).toEqual([]);
    expect(doc.checks.find((check) => check.name === "tracker-auth")?.status, shown).toBe("pass");
    expect(doc.nextSteps[0]?.id, shown).toBe("sign-in");
    expect(doc.nextSteps[0]?.command, shown).toMatch(/^devintern worker login\b/);
    // Secrets saved by init stay private to the user.
    expect((await checked(`stat -c %a ${WORKSPACE}/.env`)).trim()).toBe("600");
  });

  step("test-only workspace settings", async () => {
    // The run must never open a PR against the shared default branch, and a
    // 60 s poll would make the run slow: pin the unique base and poll every
    // 5 s (GitHub search allows 30 requests a minute). Status labels let the
    // test check the issue's label transitions.
    await checked(
      [
        "set -eu",
        `sed -i 's|^worker_task_args = .*|worker_task_args = "--create-pr --skip-clarity-check --pr-target-branch ${BASE}"|; s|^poll_interval = .*|poll_interval = 5|' ${WORKSPACE}/workspace.toml`,
        // Newer init records the checkout's branch itself; older ones leave
        // default_branch to origin/HEAD.
        `if grep -q '^default_branch = ' ${WORKSPACE}/workspace.toml; then`,
        `  sed -i 's|^default_branch = .*|default_branch = "${BASE}"|' ${WORKSPACE}/workspace.toml`,
        "else",
        `  sed -i '0,/^remote = /{s|^\\(remote = .*\\)$|\\1\\ndefault_branch = "${BASE}"|}' ${WORKSPACE}/workspace.toml`,
        "fi",
        `cat >> ${WORKSPACE}/workspace.toml <<'EOF'`,
        "",
        `[trackers.github.projects."${repository}"]`,
        `todo_status = "${TRACKER_STATUS_SETTINGS.todoStatus}"`,
        `in_progress_status = "${TRACKER_STATUS_SETTINGS.inProgressStatus}"`,
        `pr_status = "${TRACKER_STATUS_SETTINGS.prStatus}"`,
        "EOF",
        `grep -q '^default_branch = "${BASE}"' ${WORKSPACE}/workspace.toml`,
        `grep -q -- '--pr-target-branch ${BASE}"' ${WORKSPACE}/workspace.toml`,
        // Stands in for signing in: no CI account can complete the Worker
        // Pilot sign-in. Non-release builds honour it; the published release
        // build ignores it, which the release-mode steps below assert.
        `echo DEVINTERN_SKIP_LICENSE_CHECK=1 >> ${WORKSPACE}/.env`,
      ].join("\n"),
    );
  });

  step(
    "release build: worker doctor --json still needs sign-in (the skip flag is ignored)",
    async () => {
      const { exitCode, doc } = await json<DoctorReport>("worker doctor");
      const shown = JSON.stringify(doc, null, 2);
      expect(doc.schema).toBe("devintern.worker-doctor");
      expect(
        doc.checks.filter((check) => check.status === "fail"),
        shown,
      ).toEqual([]);
      expect(doc.result, shown).toBe("action_required");
      expect(exitCode, shown).toBe(2);
      expect(doc.setup, shown).toBe("action_required");
      expect(doc.nextSteps[0]?.id, shown).toBe("sign-in");
      expect(
        doc.nextSteps.map((next) => next.id),
        shown,
      ).not.toContain("service");
    },
    { skip: !releaseBuild },
  );

  step(
    "release build: worker service install refuses until sign-in (exit 2)",
    async () => {
      const { exitCode, doc } = await json<ServiceDoc>("worker service install");
      const shown = JSON.stringify(doc, null, 2);
      expect(doc.result, shown).toBe("action_required");
      expect(exitCode, shown).toBe(2);
      // Sign in first, then install the service.
      expect(
        doc.nextSteps.map((next) => next.id),
        shown,
      ).toEqual(["sign-in", "service"]);
      expect(await sh(`test -e ${UNIT}`)).toMatchObject({ exitCode: 1 });
      expect((await json<ServiceDoc>("worker service status")).doc.result).toBe("not_installed");
    },
    { skip: !releaseBuild },
  );

  step(
    "release build: a LICENSE_KEY in the workspace .env replaces sign-in",
    async () => {
      // What a user with a paid license does: add the key to the workspace
      // .env (kept 0600). The relay is not paired with it.
      await container.appendPrivateFile(USER, `${WORKSPACE}/.env`, `LICENSE_KEY=${licenseKey}\n`);
      expect((await checked(`stat -c %a ${WORKSPACE}/.env`)).trim()).toBe("600");
    },
    { skip: !releaseBuild || !licenseKey },
  );

  step(
    "worker doctor --json: ready",
    async () => {
      const { exitCode, doc } = await json<DoctorReport>("worker doctor");
      const shown = JSON.stringify(doc, null, 2);
      expect(doc.schema).toBe("devintern.worker-doctor");
      expect(
        doc.checks.filter((check) => check.status === "fail"),
        shown,
      ).toEqual([]);
      expect(doc.result, shown).toBe("success");
      expect(exitCode, shown).toBe(0);
      // Every check passes and no worker runs yet: starting it is what is left.
      expect(doc.setup, shown).toBe("ready");
      expect(
        doc.nextSteps.map((next) => next.id),
        shown,
      ).toContain("service");
      expect(
        doc.nextSteps.map((next) => next.id),
        shown,
      ).not.toContain("sign-in");
    },
    { skip: !fullPath },
  );

  step(
    "worker service install --json: running, with the pid systemd reports",
    async () => {
      const { exitCode, doc } = await json<ServiceDoc>("worker service install");
      const shown = JSON.stringify(doc, null, 2);
      expect(doc.schema).toBe("devintern.worker-service");
      expect(doc.result, shown).toBe("running");
      expect(exitCode, shown).toBe(0);
      expect(doc.start?.pid).toBeGreaterThan(0);
      expect(doc.start?.pid).toBe(Number(await unitProperty("MainPID")));
      expect(await unitProperty("ActiveState")).toBe("active");
      // The unit runs the global install with the user's bun, so systemd's
      // minimal PATH cannot break it.
      expect(await checked(`cat ${UNIT}`)).toMatch(
        new RegExp(`^ExecStart=${HOME}/\\.bun/bin/bun "?${HOME}/\\.bun/install/global/`, "m"),
      );
      const status = await json<ServiceDoc>("worker service status");
      expect(status.exitCode, JSON.stringify(status.doc, null, 2)).toBe(0);
      expect(status.doc.result).toBe("running");
      expect(status.doc.service).toMatchObject({ installed: true, worker: { status: "running" } });
      // Installing again changes nothing and keeps the same worker.
      const again = await json<ServiceDoc>("worker service install");
      expect(again.exitCode, JSON.stringify(again.doc, null, 2)).toBe(0);
      expect(again.doc.unchanged, JSON.stringify(again.doc, null, 2)).toBe(true);
      expect(Number(await unitProperty("MainPID"))).toBe(doc.start?.pid ?? -1);
      // With the worker running, the doctor calls setup done.
      const doctor = await json<DoctorReport>("worker doctor");
      expect(doctor.doc.setup, JSON.stringify(doctor.doc, null, 2)).toBe("complete");
      expect(doctor.exitCode).toBe(0);
    },
    { skip: !fullPath },
  );

  step(
    "the service worker picks up a labelled issue and opens the PR",
    async () => {
      const title = `E2E golden ${runId} Expand the greeting`;
      const issue = await tracker.createTicket({
        title,
        body: `# ${title}\n\nChange the greeting to Hello, world! and run bun test.\n`,
        labels: [TRIGGER_LABEL, TRACKER_UNRELATED_LABEL, TRACKER_STATUS_SETTINGS.todoStatus],
      });
      ownedIssues.push(issue.key);
      const head = `feature/${issue.key}`;
      ownedBranches.add(head);

      const deadline = Date.now() + PR_TIMEOUT_MS;
      let pull = (await github.pulls(head)).find((candidate) => candidate.base.ref === BASE);
      while (!pull) {
        if (Date.now() >= deadline) {
          throw new Error(`No PR from ${head} into ${BASE} after ${PR_TIMEOUT_MS / 1000}s`);
        }
        await Bun.sleep(5_000);
        pull = (await github.pulls(head)).find((candidate) => candidate.base.ref === BASE);
      }
      expect(pull.state).toBe("open");
      expect(pull.head.ref).toBe(head);
      expect(pull.base.ref).toBe(BASE);
      expect(pull.title).toBe(`[${issue.key}] ${title}`);
      const files = await github.request<Array<{ filename: string }>>(
        `/pulls/${pull.number}/files`,
      );
      expect(files.map((file) => file.filename)).toEqual(["src/greeting.ts"]);
      expect(await github.fileContents("src/greeting.ts", head)).toBe(
        'export const greeting = "Hello, world!";\n',
      );

      // The tracker side, read back through the API. The worker moves the
      // issue to the PR status just after it opens the PR, so wait for that.
      let state = await tracker.getTicket(issue.key);
      const labelDeadline = Date.now() + 60_000;
      while (
        state.labels.includes(TRACKER_STATUS_SETTINGS.inProgressStatus) ||
        !state.labels.includes(TRACKER_STATUS_SETTINGS.prStatus)
      ) {
        if (Date.now() >= labelDeadline) break;
        await Bun.sleep(2_000);
        state = await tracker.getTicket(issue.key);
      }
      expect(state.state).toBe("open");
      expect(state.labels).toContain(TRACKER_STATUS_SETTINGS.prStatus);
      expect(state.labels).toContain(TRACKER_UNRELATED_LABEL);
      expect(state.labels).not.toContain(TRACKER_STATUS_SETTINGS.todoStatus);
      expect(state.labels).not.toContain(TRACKER_STATUS_SETTINGS.inProgressStatus);
      const comments = await tracker.listComments(issue.key);
      expect(comments.some((comment) => comment.body.includes(IMPLEMENTATION_COMMENT_MARKER))).toBe(
        true,
      );

      // A later poll sees the issue again and skips it.
      const skipped = new RegExp(`skipping ${issue.key} \\(already actioned`);
      const skipDeadline = Date.now() + 90_000;
      for (;;) {
        const log = await sh(`cat ${WORKSPACE}/worker.stdout.log ${WORKSPACE}/worker.stderr.log`);
        if (skipped.test(log.stdout)) break;
        if (Date.now() >= skipDeadline) throw new Error("No later poll skipped the actioned issue");
        await Bun.sleep(3_000);
      }
      const invocations = (await checked(`cat ${AGENT_LOG}`)).trim().split("\n");
      expect(invocations.map((line) => (JSON.parse(line) as { mode: string }).mode)).toEqual([
        "implement",
      ]);
      expect(await unitProperty("ActiveState")).toBe("active");
    },
    { timeout: PR_TIMEOUT_MS + 180_000, skip: !fullPath },
  );

  step(
    "service stop is a clean exit, then restart and uninstall",
    async () => {
      const stopped = await json<ServiceDoc>("worker service stop");
      expect(stopped.exitCode, JSON.stringify(stopped.doc, null, 2)).toBe(0);
      expect(stopped.doc.result).toBe("stopped");
      expect(await unitProperty("ActiveState")).toBe("inactive");
      expect(await unitProperty("Result")).toBe("success");
      const status = await json<ServiceDoc>("worker service status");
      expect(status.doc.result, JSON.stringify(status.doc, null, 2)).not.toBe("failed");
      expect(status.doc.service?.worker.status).toBe("stopped");

      const restarted = await json<ServiceDoc>("worker service restart");
      expect(restarted.exitCode, JSON.stringify(restarted.doc, null, 2)).toBe(0);
      expect(restarted.doc.result).toBe("running");
      expect(restarted.doc.start?.pid).toBe(Number(await unitProperty("MainPID")));

      const removed = await json<ServiceDoc>("worker service uninstall");
      expect(removed.exitCode, JSON.stringify(removed.doc, null, 2)).toBe(0);
      expect(removed.doc.result).toBe("uninstalled");
      expect(await sh(`test -e ${UNIT}`)).toMatchObject({ exitCode: 1 });
      expect((await json<ServiceDoc>("worker service status")).doc.result).toBe("not_installed");
    },
    { timeout: 300_000, skip: !fullPath },
  );

  step(
    "interactive wizard for a new user: markdown, every offer declined, honest readiness",
    async () => {
      await installCli(NEWCOMER);
      const setup = await container.login(
        NEWCOMER,
        [
          "set -eu",
          "git init -q --bare -b main ~/remote.git",
          "git init -q -b main ~/app",
          "cd ~/app && echo '# app' > README.md && git add README.md",
          "git -c user.name=seed -c user.email=seed@example.invalid commit -qm init",
          "git remote add origin ~/remote.git && git push -q -u origin main",
          "mkdir -p ~/tasks && printf -- '---\\nstatus: todo\\n---\\n# Sample\\n\\nDo a thing.\\n' > ~/tasks/T-1.md",
          // An agent CLI on the profile PATH, so sign-in is the only open item.
          "mkdir -p ~/.local/bin && printf '#!/bin/sh\\necho stub agent 0.0.0\\n' > ~/.local/bin/claude && chmod +x ~/.local/bin/claude",
        ].join("\n"),
      );
      expect(setup.exitCode, setup.stdout + setup.stderr).toBe(0);

      const wizard = await runWizard();
      const output = wizard.output;
      expect(wizard.seen, output).toEqual(
        expect.arrayContaining(["tracker", "tasks-dir", "query", "sign-in", "relay"]),
      );
      expect(output).toContain("✅ Query works: 1 task(s) match right now.");
      // No settings question: the recommended settings are written.
      expect(wizard.seen).not.toContain("ci-repair");
      expect(output).toContain("💾 Wrote the recommended worker settings to workspace.toml (");
      expect(output).toContain("📋 Readiness (the same checks as `devintern worker doctor`):");
      expect(output).toContain(
        "👉 Worker setup saved. One step left: sign in to begin your 14-day free Worker Pilot, no card required.",
      );
      expect(output).not.toMatch(/❌/);
      expect(output).not.toContain("🎉 Worker setup complete");
      expect(output).not.toMatch(/^\s+at\s.+[(:]\d+/m);
      // Setup is saved and only signing in is left: exit 2.
      expect(wizard.exitCode, output).toBe(2);
      // Declining the service installed nothing.
      const unit = await container.login(
        NEWCOMER,
        "test -e ~/.config/systemd/user/devintern-worker.service",
      );
      expect(unit.exitCode).toBe(1);
      expect(
        (
          await container.login(
            NEWCOMER,
            "grep -c '^tracker = \"markdown\"' ~/.devintern/workspace.toml",
          )
        ).stdout.trim(),
      ).toBe("1");
    },
    { timeout: 420_000, independent: true, skip: !ptyAvailable },
  );

  /** Push the fixture project to this run's unique base branch. */
  async function seedBaseBranch(): Promise<void> {
    ownedBranches.add(BASE);
    // Seeded from inside the container with a one-off credential helper, so
    // the host needs no git credentials and the token never reaches argv.
    await container.writePrivateFile(USER, `${HOME}/.seed-token`, token);
    await checked(
      [
        "set -eu",
        "rm -rf ~/seed && mkdir ~/seed && cd ~/seed",
        "cp -r /opt/e2e/fixture/. .",
        `git init -q -b ${BASE}`,
        "git add .",
        "git -c user.name='Fixture Seed' -c user.email=seed@example.invalid commit -qm 'Seed golden path fixture'",
        `git -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat ~/.seed-token)"; }; f' push -q https://github.com/${repository}.git HEAD:refs/heads/${BASE} </dev/null`,
        "cd ~ && rm -rf ~/seed ~/.seed-token",
      ].join("\n"),
      120_000,
    );
  }

  /**
   * `devintern worker init` for `newcomer` on a real PTY: the host runs
   * `docker exec -it` inside a Bun terminal, so the wizard sees a TTY.
   * Prompts are answered by pattern; any other prompt takes its default.
   */
  async function runWizard(): Promise<{ exitCode: number; output: string; seen: string[] }> {
    const rules: Array<[id: string, prompt: RegExp, keys: string]> = [
      ["tracker", /Enter a number \(1-\d+\) or tracker id: $/, "markdown\r"],
      [
        "tasks-dir",
        /Directory containing markdown task files[^\n]*: $/,
        `/home/${NEWCOMER}/tasks\r`,
      ],
      ["token", /GitHub token for creating pull requests[^\n]*: $/, "\r"],
      ["query", /Ready-tasks query[^\n]*: $/, "status=todo\r"],
      ["relay-sign-in", /Sign in now to connect the relay[^\n]*\]: $/, "n\r"],
      ["ci-repair", /Automatically repair failing CI[^\n]*\]: $/, "n\r"],
      ["hours", /Limit new-task pickup to active hours[^\n]*\]: $/, "n\r"],
      ["sentry", /Sentry[^\n]*\]: $/, "n\r"],
      ["sign-in", /Sign in now[^\n]*Worker Pilot[^\n]*\]: $/, "n\r"],
      ["relay", /React in seconds through the DevIntern relay[^\n]*\]: $/, "n\r"],
      ["service", /background service[^\n]*\]: $/, "n\r"],
      ["default", /\]: $/, "\r"],
    ];
    const session = new PtySession(
      [
        "docker",
        "exec",
        "-it",
        "-u",
        NEWCOMER,
        "-w",
        `/home/${NEWCOMER}/app`,
        "-e",
        "DEVINTERN_TELEMETRY_DISABLED=1",
        "-e",
        "DEVINTERN_NO_UPDATE=1",
        container.name,
        "bash",
        "-l",
        "-c",
        "devintern worker init",
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          TERM: "xterm",
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
        },
      },
    );
    const seen: string[] = [];
    try {
      const deadline = Date.now() + 360_000;
      let consumed = 0;
      let lastLength = 0;
      let lastChange = Date.now();
      while (session.exitCode === null) {
        const screen = session.output;
        if (screen.length !== lastLength) {
          lastLength = screen.length;
          lastChange = Date.now();
        }
        // A prompt nobody answers: fail now, naming it, instead of at the deadline.
        if (Date.now() > deadline || Date.now() - lastChange > 90_000) {
          throw new Error(`worker init stopped at an unanswered prompt.\n${screen}`);
        }
        const pending = screen.slice(consumed);
        const rule = rules.find(([, prompt]) => prompt.test(pending));
        if (rule) {
          consumed = screen.length;
          seen.push(rule[0]);
          session.write(rule[2]);
        }
        await Bun.sleep(50);
      }
      const exitCode = await session.waitForExit(deadline, "worker init");
      return { exitCode, output: session.output, seen };
    } finally {
      session.close();
    }
  }
});
