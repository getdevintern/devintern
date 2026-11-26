/**
 * `devintern worker init` interactive wizard, driven through a Bun
 * pseudo-terminal (`Bun.spawn({ terminal })`, Bun >= 1.3.5; no `expect` or
 * `script` binary needed).
 *
 * Keystrokes are written to the PTY as raw bytes: `\x04` (Ctrl+D) and `\x03`
 * (Ctrl+C) reach the wizard's raw-mode readline exactly as they would from a
 * real keyboard. Closing stdin (or `script` with `</dev/null`) does not, so
 * those approaches cannot test the abort paths.
 *
 * Everything stays offline: a Markdown tracker, a local bare `origin`, and a
 * refusing loopback proxy for HTTP(S) that must see zero requests.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath } from "../../helpers/fixture-workspace";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { STACK_TRACE_PATTERNS, WorkerInitFixture, stripAnsi } from "../../helpers/worker-init";

const ptyAvailable = typeof Bun.Terminal === "function" && process.platform !== "win32";
if (!ptyAvailable) {
  console.warn(
    "worker-init-wizard: skipping; Bun pseudo-terminal support is unavailable on this platform.",
  );
}
const ptyTest = test.skipIf(!existsSync(cliPath) || !ptyAvailable);

const CTRL_C = "\x03";
const CTRL_D = "\x04";

/** A prompt (matched at the end of the screen output) and the bytes to send. */
type Answer = [prompt: RegExp, keys: string];

const TRACKER_PROMPT = /Enter a number \(1-\d+\) or tracker id: $/;
const QUERY_PROMPT = /Ready-tasks query: $/;

const TOKEN_PROMPT = /GitHub token for creating pull requests[^\n]*: $/;
const SIGN_IN_PROMPT = /Sign in now to start your 14-day free Worker Pilot[^\n]*\[Y\/n\]: $/;

interface AnswerOptions {
  /** Typed at the tasks-directory prompt (default: the fixture's absolute path). */
  tasksDir?: string;
  /** Typed at the hidden GitHub token prompt (default: Enter to skip). */
  token?: string;
  /** False when the license check is skipped, so there is no sign-in prompt. */
  licensing?: boolean;
}

/** Every wizard prompt for the Markdown path, answered with defaults or "no". */
function markdownAnswers(fixture: WorkerInitFixture, options: AnswerOptions = {}): Answer[] {
  return [
    [TRACKER_PROMPT, "1\r"],
    [
      /Directory containing markdown task files[^\n]*: $/,
      `${options.tasksDir ?? fixture.tasksDir}\r`,
    ],
    [TOKEN_PROMPT, `${options.token ?? ""}\r`],
    [QUERY_PROMPT, "status=todo\r"],
    [/Automatically repair failing CI[^\n]*\[y\/N\]: $/, "n\r"],
    [/Conflict handling[^\n]*\[auto\]: $/, "\r"],
    [/Limit new-task pickup to active hours\? \[y\/N\]: $/, "n\r"],
    [/Watch a Sentry project[^\n]*\[y\/N\]: $/, "n\r"],
    ...(options.licensing === false ? [] : ([[SIGN_IN_PROMPT, "n\r"]] as Answer[])),
    [/React in seconds through the DevIntern relay[^\n]*\[Y\/n\]: $/, "n\r"],
  ];
}

interface WizardRun {
  exitCode: number;
  output: string;
  /** Terminal bytes before ANSI stripping. */
  rawOutput: string;
  /** Prompts that were answered, in order (by index into the answer list). */
  answered: number[];
}

/**
 * Run `worker init` on a PTY. Answers are matched in order against the tail of
 * the output; a prompt that never appears before the process exits fails the
 * run.
 */
async function runWizard(
  fixture: WorkerInitFixture,
  proxy: RecordingProxy,
  answers: Answer[],
  options: { licensing?: boolean } = {},
): Promise<WizardRun> {
  let raw = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, cliPath, "worker", "init"], {
    cwd: fixture.repoDir,
    env: {
      ...fixture.env,
      ...proxyEnvironment(proxy.url),
      TERM: "xterm",
      // Licensing on, with no key or session in the temp HOME: the wizard
      // offers the Worker Pilot sign-in, which most cases decline.
      DEVINTERN_SKIP_LICENSE_CHECK: options.licensing === false ? "1" : "0",
      WORKER_RELAY_URL: proxy.url,
      DEVINTERN_API_BASE: proxy.url,
    },
    terminal: {
      cols: 200,
      rows: 50,
      data: (_terminal, data) => {
        raw += decoder.decode(data, { stream: true });
      },
    },
  });
  const answered: number[] = [];
  try {
    const deadline = Date.now() + 90_000;
    let consumed = 0;
    for (const [index, [prompt, keys]] of answers.entries()) {
      for (;;) {
        const screen = stripAnsi(raw);
        if (prompt.test(screen.slice(consumed))) {
          consumed = screen.length;
          break;
        }
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(
            `Prompt ${prompt} never appeared (exit ${child.exitCode}).\n${stripAnsi(raw)}`,
          );
        }
        await Bun.sleep(20);
      }
      child.terminal!.write(keys);
      answered.push(index);
    }
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(Math.max(deadline - Date.now(), 1)).then(() => {
        throw new Error(`worker init did not exit.\n${stripAnsi(raw)}`);
      }),
    ]);
    // Let the PTY drain the final lines written just before exit.
    await Bun.sleep(100);
    return { exitCode, output: stripAnsi(raw), rawOutput: raw, answered };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.terminal?.close();
  }
}

async function withWizardFixture(
  run: (fixture: WorkerInitFixture, proxy: RecordingProxy) => Promise<void>,
): Promise<void> {
  const fixture = new WorkerInitFixture();
  const proxy = await startRecordingProxy();
  try {
    await fixture.seedRepository();
    await run(fixture, proxy);
    expect(proxy.requests()).toEqual([]);
  } finally {
    await proxy.close();
    fixture.release();
  }
}

/** Output after the last answered prompt. */
function tailAfter(output: string, prompt: RegExp): string {
  const match = [...output.matchAll(new RegExp(prompt.source.replace(/\$$/, ""), "g"))].at(-1);
  return match ? output.slice(match.index! + match[0].length) : output;
}

/** Aborted prompts end with one clean `❌` line naming how the input stopped. */
function expectCleanAbort(run: WizardRun, prompt: RegExp, reason: string): void {
  expect(run.exitCode, run.output).not.toBe(0);
  for (const pattern of STACK_TRACE_PATTERNS) expect(run.output).not.toMatch(pattern);
  const tail = tailAfter(run.output, prompt)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  expect(tail).toHaveLength(1);
  expect(tail[0]).toStartWith("❌");
  expect(tail[0]).toContain(reason);
}

ptyTest(
  "worker init wizard: markdown happy path (license check skipped) reports ready with every readiness check passing",
  async () => {
    await withWizardFixture(async (fixture, proxy) => {
      const answers = markdownAnswers(fixture, { licensing: false });
      const run = await runWizard(fixture, proxy, answers, { licensing: false });
      expect(run.exitCode, run.output).toBe(0);
      expect(run.answered).toHaveLength(answers.length);
      for (const pattern of STACK_TRACE_PATTERNS) expect(run.output).not.toMatch(pattern);
      expect(run.output).not.toMatch(SIGN_IN_PROMPT);
      expect(run.output).toContain("✅ Query works: 1 task(s) match right now.");
      expect(run.output).toContain("Sentry auto-fixes skipped");
      expect(run.output).toContain("Relay skipped.");
      expect(run.output).toContain("📋 Readiness (the same checks as `devintern worker doctor`):");
      expect(run.output).not.toContain("❌");
      expect(run.output).toContain("🎉 Worker setup complete — the worker is ready.");

      const config = fixture.config();
      expect(config.defaults).toMatchObject({ tracker: "markdown", task_query: "status=todo" });
      expect(config.repos).toEqual([
        expect.objectContaining({ name: "acme-app", remote: fixture.remoteDir }),
      ]);
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(fixture.envPath, "utf8")).toContain(
        `MARKDOWN_TASKS_DIR=${fixture.tasksDir}`,
      );
      // The PATH has no systemctl, so no service is offered and no unit file is written.
      expect(fixture.workspaceFiles()).toEqual([".env", "workspace.toml"]);
    });
  },
  180_000,
);

ptyTest(
  "worker init wizard: declining the sign-in saves the setup and says signing in is the one step left",
  async () => {
    await withWizardFixture(async (fixture, proxy) => {
      const answers = markdownAnswers(fixture);
      const run = await runWizard(fixture, proxy, answers);
      expect(run.answered).toHaveLength(answers.length);
      for (const pattern of STACK_TRACE_PATTERNS) expect(run.output).not.toMatch(pattern);
      expect(run.output).toContain("📋 Readiness (the same checks as `devintern worker doctor`):");
      // No session yet is a step, not a broken setup.
      expect(run.output).toContain(
        "👉 Automation entitlement — Not started: sign in to begin your 14-day free Worker Pilot, no card required",
      );
      expect(run.output).not.toMatch(/❌ Automation entitlement/);
      expect(run.output).toContain(
        "👉 Worker setup saved. One step left: sign in to begin your 14-day free Worker Pilot, no card required.",
      );
      expect(run.output).not.toContain("not ready yet");
      expect(run.output).toMatch(
        /1\. Automation entitlement: Run `devintern worker login( --workspace \S+)? github`/,
      );
      expect(run.output).not.toContain("🎉 Worker setup complete");
      // Setup is saved, so the wizard itself still exits 0; the next steps carry the failure.
      expect(run.exitCode, run.output).toBe(0);
      // The setup itself is kept.
      expect(fixture.config().defaults).toMatchObject({
        tracker: "markdown",
        task_query: "status=todo",
      });
    });
  },
  180_000,
);

ptyTest(
  "worker init wizard: after a non-interactive init it reuses the tracker instead of asking again",
  async () => {
    await withWizardFixture(async (fixture, proxy) => {
      const init = await fixture.init(["--json"]);
      expect(init.exitCode, init.stderr).toBe(0);

      // Drop the tracker, tasks-directory and PR-token prompts (already configured).
      // The query prompt shows the saved query as its default: keep it.
      const answers: Answer[] = [
        [/Ready-tasks query[^\n]*: $/, "\r"],
        ...markdownAnswers(fixture, { licensing: false }).slice(4),
      ];
      const run = await runWizard(fixture, proxy, answers, { licensing: false });
      expect(run.exitCode, run.output).toBe(0);
      expect(run.output).toContain("Using markdown from");
      expect(run.output).not.toContain("No tracker config yet");
      expect(run.output).not.toMatch(TRACKER_PROMPT);
      for (const pattern of STACK_TRACE_PATTERNS) expect(run.output).not.toMatch(pattern);

      // Re-running the non-interactive init afterwards keeps the same setup.
      const again = await fixture.init(["--yes", "--json"]);
      expect(again.exitCode, again.stderr).toBe(0);
      expect(fixture.config().defaults).toMatchObject({
        tracker: "markdown",
        task_query: "status=todo",
      });
      expect(fixture.config().repos).toHaveLength(1);
      expect(readFileSync(fixture.envPath, "utf8")).toContain(
        `MARKDOWN_TASKS_DIR=${fixture.tasksDir}`,
      );
    });
  },
  180_000,
);

for (const [name, key, reason] of [
  ["Ctrl+D", CTRL_D, "Input closed (Ctrl+D)"],
  ["Ctrl+C", CTRL_C, "Interrupted (Ctrl+C)"],
] as const) {
  ptyTest(
    `worker init wizard: ${name} at the first prompt exits cleanly and writes nothing`,
    async () => {
      await withWizardFixture(async (fixture, proxy) => {
        const run = await runWizard(fixture, proxy, [[TRACKER_PROMPT, key]]);
        expectCleanAbort(run, TRACKER_PROMPT, reason);
        expect(fixture.workspaceFiles()).toEqual([]);
      });
    },
    120_000,
  );

  ptyTest(
    `worker init wizard: ${name} at the mid-flow query prompt exits cleanly, keeps the chosen tracker, and a re-run completes`,
    async () => {
      await withWizardFixture(async (fixture, proxy) => {
        const answers = markdownAnswers(fixture, { licensing: false });
        const queryIndex = answers.findIndex(([prompt]) => prompt === QUERY_PROMPT);
        const aborted = await runWizard(
          fixture,
          proxy,
          [...answers.slice(0, queryIndex), [QUERY_PROMPT, key]],
          { licensing: false },
        );
        expectCleanAbort(aborted, QUERY_PROMPT, reason);

        // The tracker was written when the workspace was created, so the
        // half-initialised workspace is not left on the "jira" default.
        expect(fixture.config().defaults).toMatchObject({ tracker: "markdown" });

        // The re-run recovers instead of refusing the half-initialised workspace.
        const rerun = await runWizard(
          fixture,
          proxy,
          [[QUERY_PROMPT, "status=todo\r"], ...answers.slice(queryIndex + 1)],
          { licensing: false },
        );
        expect(rerun.exitCode, rerun.output).toBe(0);
        for (const pattern of STACK_TRACE_PATTERNS) expect(rerun.output).not.toMatch(pattern);
        expect(rerun.output).toContain("🎉 Worker setup complete — the worker is ready.");
        expect(fixture.config().defaults).toMatchObject({
          tracker: "markdown",
          task_query: "status=todo",
        });
        expect(fixture.config().repos).toHaveLength(1);
      });
    },
    180_000,
  );
}

ptyTest(
  "worker init wizard: a relative tasks directory is saved as an absolute path that doctor resolves from another cwd",
  async () => {
    await withWizardFixture(async (fixture, proxy) => {
      // `./tasks` is relative to the checkout the wizard runs in.
      const tasks = join(fixture.repoDir, "tasks");
      mkdirSync(tasks);
      writeFileSync(
        join(tasks, "T-1.md"),
        "---\nstatus: todo\n---\n# Relative task\n\nDo a thing.\n",
      );
      const answers = markdownAnswers(fixture, { tasksDir: "./tasks", licensing: false });
      const run = await runWizard(fixture, proxy, answers, { licensing: false });
      expect(run.exitCode, run.output).toBe(0);
      expect(readFileSync(fixture.envPath, "utf8")).toContain(`MARKDOWN_TASKS_DIR=${tasks}\n`);

      // From an unrelated directory, a relative value would point nowhere.
      const doctor = await fixture.run(["worker", "doctor"], {
        cwd: fixture.root,
        env: { DEVINTERN_SKIP_LICENSE_CHECK: "1" },
      });
      expect(doctor.stdout).toContain("1 task matches");
      expect(doctor.stdout).not.toContain("❌");
      expect(doctor.exitCode, doctor.stdout + doctor.stderr).toBe(0);
    });
  },
  180_000,
);

ptyTest(
  "worker init wizard: the token prompt does not echo the typed secret and the token is saved to .env",
  async () => {
    await withWizardFixture(async (fixture, proxy) => {
      const token = `ghp_${randomUUID().replaceAll("-", "")}`;
      const answers = markdownAnswers(fixture, { token, licensing: false });
      const run = await runWizard(fixture, proxy, answers, { licensing: false });
      expect(run.exitCode, run.output).toBe(0);
      expect(run.rawOutput).toContain("input hidden");
      expect(run.rawOutput).not.toContain(token);
      // Nor a prefix long enough to be a leaked echo of the typed characters.
      expect(run.rawOutput).not.toContain(token.slice(0, 12));
      expect(readFileSync(fixture.envPath, "utf8")).toContain(`GITHUB_TOKEN=${token}`);
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);
    });
  },
  180_000,
);
