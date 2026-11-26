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
import { existsSync, readFileSync, statSync } from "node:fs";
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

/** Every wizard prompt for the Markdown path, answered with defaults or "no". */
function markdownAnswers(fixture: WorkerInitFixture): Answer[] {
  return [
    [TRACKER_PROMPT, "1\r"],
    [/Directory containing markdown task files[^\n]*: $/, `${fixture.tasksDir}\r`],
    [/GitHub token for creating pull requests[^\n]*: $/, "\r"],
    [QUERY_PROMPT, "status=todo\r"],
    [/Automatically repair failing CI[^\n]*\[y\/N\]: $/, "n\r"],
    [/Conflict handling[^\n]*\[auto\]: $/, "\r"],
    [/Limit new-task pickup to active hours\? \[y\/N\]: $/, "n\r"],
    [/Watch a Sentry project[^\n]*\[y\/N\]: $/, "n\r"],
    [/Sign in now to start a free Worker Pilot[^\n]*\[Y\/n\]: $/, "n\r"],
    [/React in seconds through the DevIntern relay[^\n]*\[Y\/n\]: $/, "n\r"],
    [/Install and start the background service[^\n]*\[Y\/n\]: $/, "n\r"],
  ];
}

interface WizardRun {
  exitCode: number;
  output: string;
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
      // offers the Worker Pilot sign-in, which the happy path declines.
      DEVINTERN_SKIP_LICENSE_CHECK: "0",
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
    return { exitCode, output: stripAnsi(raw), answered };
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

/** One clean `❌` line after the aborted prompt, non-zero exit, no stack trace. */
function expectCleanAbort(run: WizardRun, prompt: RegExp): void {
  expect(run.exitCode, run.output).not.toBe(0);
  for (const pattern of STACK_TRACE_PATTERNS) expect(run.output).not.toMatch(pattern);
  const tail = tailAfter(run.output, prompt)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  expect(tail).toHaveLength(1);
  expect(tail[0]).toStartWith("❌");
}

ptyTest(
  "worker init wizard: markdown happy path through every prompt, declining sign-in, relay, Sentry and service",
  async () => {
    await withWizardFixture(async (fixture, proxy) => {
      const answers = markdownAnswers(fixture);
      const run = await runWizard(fixture, proxy, answers);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.answered).toHaveLength(answers.length);
      for (const pattern of STACK_TRACE_PATTERNS) expect(run.output).not.toMatch(pattern);
      expect(run.output).toContain("✅ Query works: 1 task(s) match right now.");
      expect(run.output).toContain("Sentry auto-fixes skipped");
      expect(run.output).toContain("Relay skipped.");
      expect(run.output).toContain("🎉 Worker setup complete!");

      const config = fixture.config();
      expect(config.defaults).toMatchObject({ tracker: "markdown", task_query: "status=todo" });
      expect(config.repos).toEqual([
        expect.objectContaining({ name: "acme-app", remote: fixture.remoteDir }),
      ]);
      expect(statSync(fixture.envPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(fixture.envPath, "utf8")).toContain(
        `MARKDOWN_TASKS_DIR=${fixture.tasksDir}`,
      );
      // Declining the service writes the unit file for a manual install only.
      expect(fixture.workspaceFiles()).toEqual([
        ".env",
        "devintern-worker.service",
        "workspace.toml",
      ]);
    });
  },
  180_000,
);

for (const [name, key] of [
  ["Ctrl+D", CTRL_D],
  ["Ctrl+C", CTRL_C],
] as const) {
  ptyTest(
    `worker init wizard: ${name} at the first prompt exits cleanly and writes nothing`,
    async () => {
      await withWizardFixture(async (fixture, proxy) => {
        const run = await runWizard(fixture, proxy, [[TRACKER_PROMPT, key]]);
        expectCleanAbort(run, TRACKER_PROMPT);
        expect(fixture.workspaceFiles()).toEqual([]);
      });
    },
    120_000,
  );

  ptyTest(
    `worker init wizard: ${name} at the mid-flow query prompt exits cleanly`,
    async () => {
      await withWizardFixture(async (fixture, proxy) => {
        const answers = markdownAnswers(fixture);
        const queryIndex = answers.findIndex(([prompt]) => prompt === QUERY_PROMPT);
        const run = await runWizard(fixture, proxy, [
          ...answers.slice(0, queryIndex),
          [QUERY_PROMPT, key],
        ]);
        expectCleanAbort(run, QUERY_PROMPT);
        // The workspace state left behind is a known bug; see the todo below.
      });
    },
    120_000,
  );
}

// Known bugs being fixed in parallel. Each becomes a real assertion once the
// fix lands; do not turn these into tests that pass on the current behaviour.
for (const name of [
  'worker init wizard: Ctrl+C or Ctrl+D mid-flow leaves no workspace.toml with tracker = "jira" that blocks a re-run',
  'worker init wizard: Ctrl+C is reported as an interrupt, not as "Input closed (Ctrl+D)"',
  "worker init wizard: token prompts do not echo the typed secret to the terminal",
  "worker init wizard: a relative MARKDOWN_TASKS_DIR (./tasks) is saved as an absolute path",
]) {
  test.todo(name, () => {
    throw new Error("Known bug; see docs/coverage/worker-commands.md (worker init)");
  });
}
