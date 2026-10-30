import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Extra time between SIGTERM and SIGKILL. The CLI installs a SIGTERM handler
 * that runs gracefulShutdown (src/index.ts:425), which can spend up to 15s on
 * tracker feedback plus analytics flushes (src/index.ts:393-418), so SIGTERM
 * alone does not bound a hung run.
 *
 * The SIGTERM deadline is what decides that a run timed out; SIGKILL only
 * bounds a CLI that ignores SIGTERM so the test can still finish. Each test's
 * bun timeout must exceed `timeoutMs + CLI_KILL_GRACE_MS`, so every case below
 * passes 40000ms (default 30000ms deadline + 1.5s grace + 5s headroom) or bun's
 * timeout fires first and hides the diagnostic. The budget is a literal because
 * oxfmt expands a `test()` call whose timeout argument is an identifier.
 */
const CLI_KILL_GRACE_MS = 1500;

/**
 * Default SIGTERM deadline for a real CLI run, matching CLI_SPAWN_TIMEOUT_MS in
 * cli.test.ts:12. Fresh bun subprocesses routinely exceed 5s under full-suite
 * load (tests/cli.test.ts:7-9), so a shorter deadline fails legitimate runs.
 */
const CLI_TIMEOUT_MS = 30_000;

/**
 * Default deadline for a stub run to write its first stdout chunk when
 * `startTimeoutOnFirstOutput` is enabled. It only elapses on a broken stub, and
 * stays below the 40000ms bun budget so the thrown diagnostic wins. It is
 * separate from the caller's `timeoutMs` because the stub deadline (1s) is
 * shorter than bun's own startup time.
 */
const CLI_STARTUP_DEADLINE_MS = CLI_TIMEOUT_MS;

/**
 * Read a piped stream, giving up when `hardStop` aborts so a grandchild that
 * inherited the pipe write end cannot keep the test hanging after SIGKILL.
 * `onFirstChunk` fires once, before the first chunk is appended to the result.
 */
async function readStream(
  stream: ReadableStream<Uint8Array>,
  hardStop: AbortSignal,
  onFirstChunk?: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  let sawChunk = false;
  const cancelReader = () => {
    if (!finished) void reader.cancel().catch(() => {});
  };
  if (hardStop.aborted) cancelReader();
  else hardStop.addEventListener("abort", cancelReader, { once: true });
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sawChunk && value.length > 0) {
        sawChunk = true;
        onFirstChunk?.();
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Stream torn down by the hard stop; keep whatever was read so far.
  }
  finished = true;
  return text + decoder.decode();
}

interface RunCLIOptions {
  /**
   * Start the SIGTERM/SIGKILL deadlines on the child's first stdout chunk
   * instead of at spawn, so bun process startup is not charged against a short
   * stub deadline. A run that never writes stdout is failed after
   * `startupDeadlineMs`.
   */
  startTimeoutOnFirstOutput?: boolean;
  /**
   * How long a `startTimeoutOnFirstOutput` run may go without writing stdout
   * before it is failed. Tracked separately from `timeoutMs` because the stub
   * deadline can be shorter than bun's own startup time.
   */
  startupDeadlineMs?: number;
  /** Called once, right after the child's first stdout chunk arrives. */
  onFirstOutput?: () => void;
}

// Async so the independent CLI cases below can overlap their bun subprocesses
// (the same pattern as cli.test.ts) instead of serializing ~15s of startup.
async function runCLI(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs = CLI_TIMEOUT_MS,
  cliPath = CLI_PATH,
  options: RunCLIOptions = {},
): Promise<CLIResult> {
  const proc = Bun.spawn({
    cmd: ["bun", cliPath, ...args],
    cwd,
    env: {
      ...process.env,
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      DEVINTERN_NO_UPDATE: "1",
      // Error-path cases never reach the agent, but the CLI resolves its
      // harness before validating the file. Point that resolution at the
      // running Bun binary so the tests don't depend on an installed agent CLI
      // (the test runner scrubs ambient *_CLI_PATH values).
      AGENT_CLI_PATH: process.execPath,
      // Default artifacts to a per-test directory. The process-global default
      // is /tmp/devintern-tasks/<key> (src/lib/config/output-dir.ts:11), which
      // concurrent tests sharing a task key ("task", "test-task") would
      // overwrite; the agent then reads a sibling test's task-details.md
      // (src/lib/agent/run-harness.ts:125). Callers can still override.
      DEVINTERN_OUTPUT_DIR: join(cwd, ".devintern-output"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let hardStopFired = false;
  let timedOut = false;
  let startupExpired = false;
  let exited = false;
  // Abort is idempotent: either deadline may end the run.
  const hardStop = new AbortController();

  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const startupDeadlineMs = options.startupDeadlineMs ?? CLI_STARTUP_DEADLINE_MS;

  const startDeadlines = () => {
    if (killTimer !== undefined) return;
    // Stdout arrived, so the startup deadline no longer applies. Leaving it
    // armed would report a healthy long-running command as "wrote no stdout"
    // at startupDeadlineMs even though output was observed.
    if (startupTimer !== undefined) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    termTimer = setTimeout(() => {
      // The CLI catches SIGTERM and exits 143 (src/index.ts:425), so this timer
      // can win the race against the SIGKILL deadline below. Record it here too
      // or a hung run would look like a normal (failing) run.
      timedOut = true;
      if (!exited) proc.kill("SIGTERM");
    }, timeoutMs);
    // Hard deadline: SIGKILL is uncatchable, so the run cannot outlive it.
    killTimer = setTimeout(() => {
      hardStopFired = true;
      if (!exited) proc.kill("SIGKILL");
      hardStop.abort();
    }, timeoutMs + CLI_KILL_GRACE_MS);
  };

  if (options.startTimeoutOnFirstOutput) {
    startupTimer = setTimeout(() => {
      startupExpired = true;
      if (!exited) proc.kill("SIGKILL");
      hardStop.abort();
    }, startupDeadlineMs);
  } else {
    startDeadlines();
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout, hardStop.signal, () => {
        options.onFirstOutput?.();
        startDeadlines();
      }),
      readStream(proc.stderr, hardStop.signal),
      proc.exited.then((code) => {
        exited = true;
        return code ?? 0;
      }),
    ]);
    // A timed-out process would otherwise look like a completed run (the CLI
    // exits 143 on SIGTERM), so fail loudly instead of letting assertions on
    // pre-agent output pass.
    if (startupExpired || timedOut || hardStopFired) {
      // Ensure the child is gone before the caller deletes its cwd.
      if (!exited) await Promise.race([proc.exited, Bun.sleep(CLI_KILL_GRACE_MS)]);
      const reason = startupExpired
        ? `CLI wrote no stdout within ${startupDeadlineMs}ms`
        : `CLI timed out after ${timeoutMs}ms`;
      // The signal distinguishes a graceful SIGTERM exit from the SIGKILL
      // escalation, which is invisible in the exit code alone.
      const signal = proc.signalCode ? `, signal ${proc.signalCode}` : "";
      throw new Error(
        `${reason} (last exit code ${exitCode}${signal}).\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    return { stdout, stderr, exitCode };
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
    if (termTimer !== undefined) clearTimeout(termTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (!exited) proc.kill("SIGKILL");
  }
}

function makeTestDir(): string {
  const dir = join(tmpdir(), `md-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Short deadline: the stub's deadlines only start after its first output line. */
const STUB_TIMEOUT_MS = 1000;

function killProcess(pidFile: string): void {
  let pid = 0;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return; // Never written: the stub never got that far.
  }
  // Guard against pid 0/NaN: process.kill(0, ...) signals the whole process group.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

describe.concurrent("runCLI timeout diagnostic", () => {
  test("throws with captured output when the CLI exits on SIGTERM", async () => {
    const testDir = makeTestDir();
    // Mirrors the real CLI (src/index.ts:425): catch SIGTERM and exit 143
    // before the SIGKILL deadline, which used to look like a normal run.
    const stubCli = join(testDir, "sigterm-stub.ts");
    writeFileSync(
      stubCli,
      [
        `process.stdout.write("stub stdout before hang\\n");`,
        `process.stderr.write("stub stderr before hang\\n");`,
        `process.on("SIGTERM", () => process.exit(143));`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n"),
    );

    try {
      let error: unknown;
      try {
        // The deadline starts on the first stdout line, so bun startup (which
        // can exceed 5s under load, tests/cli.test.ts:7-9) is not charged
        // against STUB_TIMEOUT_MS.
        await runCLI([], testDir, {}, STUB_TIMEOUT_MS, stubCli, {
          startTimeoutOnFirstOutput: true,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`CLI timed out after ${STUB_TIMEOUT_MS}ms`);
      // Exited through the stub's own SIGTERM handler, i.e. before SIGKILL.
      expect(message).toContain("last exit code 143");
      expect(message).toContain("stub stdout before hang");
      expect(message).toContain("stub stderr before hang");
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("escalates to SIGKILL when the CLI ignores SIGTERM and a grandchild holds the pipe", async () => {
    const testDir = makeTestDir();
    const pidFile = join(testDir, "grandchild.pid");
    // Ignores SIGTERM (so only the SIGKILL deadline can end it) and leaves a
    // grandchild inheriting the stdout/stderr pipes, so only readStream's
    // hardStop cancellation (see above) can finish the run.
    const stubCli = join(testDir, "stubborn-stub.ts");
    writeFileSync(
      stubCli,
      [
        `import { writeFileSync } from "fs";`,
        `process.stdout.write("stubborn stdout before hang\\n");`,
        `process.stderr.write("stubborn stderr before hang\\n");`,
        `process.on("SIGTERM", () => {});`,
        `const child = Bun.spawn({ cmd: ["sleep", "60"], stdout: "inherit", stderr: "inherit" });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n"),
    );

    try {
      // Measured from the stub's first stdout chunk, not from before Bun.spawn:
      // bun startup can exceed 5s under full-suite load (tests/cli.test.ts:7-9)
      // and is not part of the hard-stop interval this test is bounding.
      let firstOutputAt: number | undefined;
      let error: unknown;
      try {
        await runCLI([], testDir, {}, STUB_TIMEOUT_MS, stubCli, {
          startTimeoutOnFirstOutput: true,
          onFirstOutput: () => {
            firstOutputAt ??= Date.now();
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(firstOutputAt).toBeDefined();
      if (firstOutputAt === undefined) throw new Error("stub never wrote stdout");
      const hardStopIntervalMs = Date.now() - firstOutputAt;
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`CLI timed out after ${STUB_TIMEOUT_MS}ms`);
      // The stub ignored SIGTERM, so the run could only end by SIGKILL.
      expect(message).toContain("signal SIGKILL");
      // Partial output survives the SIGKILL and the stream cancellation.
      expect(message).toContain("stubborn stdout before hang");
      expect(message).toContain("stubborn stderr before hang");
      // Bounded by the hard deadline rather than the grandchild's 60s sleep.
      expect(hardStopIntervalMs).toBeGreaterThanOrEqual(STUB_TIMEOUT_MS + CLI_KILL_GRACE_MS - 100);
      expect(hardStopIntervalMs).toBeLessThan(STUB_TIMEOUT_MS + CLI_KILL_GRACE_MS + 5_000);
    } finally {
      killProcess(pidFile);
      cleanup(testDir);
    }
  }, 40000);

  test("does not report a started run as a startup failure after the startup deadline", async () => {
    const testDir = makeTestDir();
    // Writes stdout immediately, then keeps running past startupDeadlineMs. The
    // startup deadline must be retired on first output, or this healthy run is
    // reported as "CLI wrote no stdout" even though stdout was observed.
    const stubCli = join(testDir, "slow-stub.ts");
    writeFileSync(
      stubCli,
      [
        `process.stdout.write("slow stub before hang\\n");`,
        `process.on("SIGTERM", () => process.exit(143));`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n"),
    );

    try {
      let error: unknown;
      try {
        await runCLI([], testDir, {}, STUB_TIMEOUT_MS, stubCli, {
          startTimeoutOnFirstOutput: true,
          startupDeadlineMs: 300,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`CLI timed out after ${STUB_TIMEOUT_MS}ms`);
      expect(message).not.toContain("wrote no stdout");
      expect(message).toContain("slow stub before hang");
    } finally {
      cleanup(testDir);
    }
  }, 40000);
});

// Fast-exit tests use /usr/bin/true as the agent so they don't wait for a real LLM.
// /usr/bin/true exits 0 immediately; the workflow sees an "incomplete" implementation
// (empty output) but the file-detection and setup phases still execute.
const FAKE_AGENT = "/usr/bin/true";

describe.concurrent("Markdown file path detection", () => {
  test("accepts an absolute .md file path as task argument", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# My Task\n\nDo the thing.\n");
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("Missing required JIRA environment variables");
      expect(output).not.toContain("Unsupported task tracker");
      expect(output).toContain("Processing markdown file");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("accepts a relative path like ./task.md", async () => {
    const testDir = makeTestDir();
    writeFileSync(join(testDir, "task.md"), "# Test\n\nContent.\n");
    try {
      const result = await runCLI(
        ["./task.md", "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("Missing required JIRA environment variables");
      expect(output).toContain("Processing markdown file");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("shows error when .md file does not exist", async () => {
    const testDir = makeTestDir();
    try {
      const result = await runCLI(
        ["/nonexistent/path/task.md", "--no-git", "--skip-clarity-check"],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).toContain("File not found");
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("shows error for empty .md file", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "empty.md");
    writeFileSync(mdFile, "   \n  ");
    try {
      const result = await runCLI([mdFile, "--no-git", "--skip-clarity-check"], testDir);
      const output = result.stdout + result.stderr;
      expect(output).toContain("empty");
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("does not require PM credentials for .md file task", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "spec.md");
    writeFileSync(mdFile, "# Feature Spec\n\nImplement the feature.\n");
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          JIRA_BASE_URL: "",
          JIRA_EMAIL: "",
          JIRA_API_TOKEN: "",
        },
      );
      const output = result.stdout + result.stderr;
      expect(output).not.toContain("Missing required JIRA environment variables");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("extracts title from H1 heading", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# My Awesome Feature\n\nDescription here.\n");
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.stdout).toContain("My Awesome Feature");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("falls back to filename when no H1 heading", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "my-feature.md");
    writeFileSync(mdFile, "Just some description without a heading.\n");
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;
      expect(output).toContain("Processing markdown file");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("uses frontmatter key as task key", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "some-file.md");
    writeFileSync(
      mdFile,
      `---
key: my-custom-key
type: Story
created_at: 2025-01-01T00:00:00Z
---

# My Task

Description.
`,
    );
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.stdout).toContain("Key: my-custom-key");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("saves task-details.md to output directory", async () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# My Task\n\nDo the thing.\n");
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          DEVINTERN_OUTPUT_DIR: outputDir,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(outputDir)).toBe(true);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("appends implementation instructions when not present", async () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "my-task.md");
    writeFileSync(mdFile, "# My Task\n\nDo the thing.\n");
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          DEVINTERN_OUTPUT_DIR: outputDir,
        },
      );
      expect(result.exitCode).toBe(0);
      const taskDetailsDir = join(outputDir, "my-task");
      if (existsSync(taskDetailsDir)) {
        const taskDetails = readFileSync(join(taskDetailsDir, "task-details.md"), "utf8");
        expect(taskDetails).toContain("## Implementation Instructions");
      }
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("keeps file instructions framed and appends trusted instructions", async () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "my-task.md");
    writeFileSync(
      mdFile,
      "# My Task\n\nDo the thing.\n\n## Implementation Instructions\n\nAlready here.\n",
    );
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          DEVINTERN_OUTPUT_DIR: outputDir,
        },
      );
      expect(result.exitCode).toBe(0);
      const taskDetailsDir = join(outputDir, "my-task");
      if (existsSync(taskDetailsDir)) {
        const taskDetails = readFileSync(join(taskDetailsDir, "task-details.md"), "utf8");
        const count = (taskDetails.match(/## Implementation Instructions/g) || []).length;
        expect(count).toBe(2);
        const boundary = "<!-- END UNTRUSTED EXTERNAL CONTENT: local task file -->";
        expect(taskDetails.indexOf("Already here.")).toBeLessThan(taskDetails.indexOf(boundary));
        expect(taskDetails.slice(taskDetails.indexOf(boundary))).toContain(
          "Please analyze the above task description",
        );
      }
    } finally {
      cleanup(testDir);
    }
  }, 40000);
});

describe.concurrent("Markdown frontmatter status transitions", () => {
  test("updates status away from 'To Do' when frontmatter has status field", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(
      mdFile,
      `---
key: test-task
status: To Do
---

# Test Task

Description.
`,
    );
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.exitCode).toBe(0);
      const updated = readFileSync(mdFile, "utf8");
      // Status must have transitioned away from "To Do" (to "In Progress" or "Done")
      expect(updated).not.toContain("status: To Do");
      expect(updated).toContain("status:");
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("transitions to In Progress before agent runs", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(
      mdFile,
      `---
key: test-task
status: To Do
---

# Test Task

Description.
`,
    );
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.stdout).toContain("In Progress");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("does not modify file when frontmatter has no status field", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    const originalContent = `---
key: test-task
type: Story
---

# Test Task

Description.
`;
    writeFileSync(mdFile, originalContent);
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.exitCode).toBe(0);
      const after = readFileSync(mdFile, "utf8");
      expect(after).not.toContain("status:");
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("does not modify file when there is no frontmatter", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    const originalContent = "# Task\n\nNo frontmatter here.\n";
    writeFileSync(mdFile, originalContent);
    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      expect(result.exitCode).toBe(0);
      const after = readFileSync(mdFile, "utf8");
      expect(after).toBe(originalContent);
    } finally {
      cleanup(testDir);
    }
  }, 40000);
});

describe.concurrent("Unstructured markdown files", () => {
  test("processes plain prose with no heading, key, or frontmatter", async () => {
    const testDir = makeTestDir();
    const outputDir = join(testDir, "output");
    const mdFile = join(testDir, "backlog-item.md");
    const originalContent =
      "Implement caching for the user profile endpoint.\n\nAcceptance: p95 under 200ms.\n";
    writeFileSync(mdFile, originalContent);

    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        { DEVINTERN_OUTPUT_DIR: outputDir },
      );
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Processing markdown file");
      expect(output).toContain("Key: backlog-item");
      expect(output).toContain("Summary: backlog-item");
      expect(output).toContain("Status: Unknown");
      expect(output).not.toContain("Updating status");

      expect(readFileSync(mdFile, "utf8")).toBe(originalContent);

      const taskDetails = readFileSync(join(outputDir, "backlog-item", "task-details.md"), "utf8");
      expect(taskDetails).toContain("Implement caching for the user profile endpoint.");
      expect(taskDetails).toContain("## Implementation Instructions");
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("processes markdown with H2 sections but no H1", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "refactor-auth.md");
    const originalContent = `## Context

Auth middleware is duplicated across services.

## Goal

Extract shared middleware package.
`;
    writeFileSync(mdFile, originalContent);

    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );

      expect(result.stdout).toContain("Key: refactor-auth");
      expect(result.stdout).toContain("Summary: refactor-auth");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(mdFile, "utf8")).toBe(originalContent);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("processes non-devpm frontmatter without key or status", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "obsidian-note.md");
    const originalContent = `---
author: me
source: obsidian
---

Random note: wire up webhook retries with exponential backoff.
`;
    writeFileSync(mdFile, originalContent);

    try {
      const result = await runCLI(
        [mdFile, "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
      );
      const output = result.stdout + result.stderr;

      expect(output).toContain("Key: obsidian-note");
      expect(output).toContain("Status: Unknown");
      expect(output).not.toContain("Updating status");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(mdFile, "utf8")).toBe(originalContent);
    } finally {
      cleanup(testDir);
    }
  }, 40000);

  test("processes batch of unstructured markdown files", async () => {
    const testDir = makeTestDir();
    writeFileSync(join(testDir, "one.md"), "First task.\n");
    writeFileSync(join(testDir, "two.md"), "Second task.\n");

    try {
      const result = await runCLI(
        ["./one.md", "./two.md", "--no-git", "--skip-clarity-check", "--agent-path", FAKE_AGENT],
        testDir,
        {
          JIRA_BASE_URL: "",
          JIRA_EMAIL: "",
          JIRA_API_TOKEN: "",
        },
      );
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Processing 2 task(s)");
      expect(output).toContain("Key: one");
      expect(output).toContain("Key: two");
    } finally {
      cleanup(testDir);
    }
  }, 40000);
});

describe.concurrent("PM frontmatter key lookup", () => {
  test("resolves short frontmatter key to slugged PM filename", async () => {
    const testDir = makeTestDir();
    const tasksDir = join(testDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const mdFile = join(tasksDir, "2026-06-06T09-42-23-kfg5-enable-agent-harness.md");
    writeFileSync(
      mdFile,
      `---
key: 2026-06-06T09-42-23-kfg5
type: Task
created_at: 2026-06-06T09:42:23.735Z
---

# Enable agent harness selection

Description.
`,
    );

    try {
      const result = await runCLI(
        [
          "2026-06-06T09-42-23-kfg5",
          "--no-git",
          "--skip-clarity-check",
          "--agent-path",
          FAKE_AGENT,
        ],
        testDir,
        {
          TASK_TRACKER: "markdown",
          MARKDOWN_TASKS_DIR: tasksDir,
        },
      );
      const output = result.stdout + result.stderr;

      expect(output).not.toContain("File not found");
      expect(output).toContain("Key: 2026-06-06t09-42-23-kfg5");
      expect(output).toContain("Enable agent harness selection");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(testDir);
    }
  }, 40000);
});

describe.concurrent("Mixed PM task keys and file paths", () => {
  test("requires PM credentials when mixing PM keys with file paths", async () => {
    const testDir = makeTestDir();
    const mdFile = join(testDir, "task.md");
    writeFileSync(mdFile, "# Task\n\nDescription.\n");
    try {
      const result = await runCLI(
        ["PROJ-123", mdFile, "--no-git", "--skip-clarity-check"],
        testDir,
        {
          JIRA_BASE_URL: "",
          JIRA_EMAIL: "",
          JIRA_API_TOKEN: "",
        },
      );
      const output = result.stdout + result.stderr;
      expect(output).toContain("Missing required JIRA environment variables");
    } finally {
      cleanup(testDir);
    }
  }, 40000);
});
