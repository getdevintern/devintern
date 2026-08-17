import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";

import { MuseHarness } from "../src/harnesses/muse.js";
import { isGitWorkspace } from "../src/harnesses/muse/git-workspace.js";
import {
  createMuseJsonlParseState,
  feedMuseJsonlChunk,
  flushMuseJsonlBuffer,
  parseMuseJsonlLine,
} from "../src/harnesses/muse/jsonl.js";
import {
  describeMuseExitState,
  mapMuseExitState,
} from "../src/harnesses/muse/exit-codes.js";
import {
  cleanupMusePromptFile,
  createMusePromptFile,
  planMusePromptDelivery,
} from "../src/harnesses/muse/prompt-file.js";
import { probeMuseCliVersion } from "../src/harnesses/muse/binary.js";
import {
  MuseConfigError,
  validateMuseRunOptions,
} from "../src/harnesses/muse/validation.js";
import { runAgentMuse } from "../src/runners/muse.js";
import { runAgentBun } from "../src/runners/bun.js";
import { runAgentNode } from "../src/runners/node.js";

const STUB_MUSE = join(import.meta.dir, "fixtures/stub-muse.ts");

/** Wrapper script so the stub is invokable as the harness executable. */
function stubExecutable(extraArgs = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-stub-exec-"));
  const script = join(dir, "muse-stub");
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nset -euo pipefail\nexec bun "${STUB_MUSE}" ${extraArgs} "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(script, 0o755);
  return script;
}

describe("MuseHarness.buildArgs", () => {
  const h = new MuseHarness();

  test("metadata", () => {
    expect(h.name).toBe("muse");
    expect(h.displayName).toBe("Muse Code");
    expect(h.defaultPath).toBe("muse");
  });

  test("defaults to exec --json with disable-approval when skipPermissions", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual([
      "exec",
      "--json",
      "--disable-approval",
    ]);
  });

  test("maps model, workspace, maxTurns, and muse options", () => {
    expect(
      h.buildArgs({
        model: "muse-spark-1.2",
        maxTurns: 42,
        workingDir: "/tmp/repo",
        muse: {
          reasoningEffort: "medium",
          sandboxNetwork: "restricted",
          subagentWorktreeIsolation: true,
          sessionId: "00000000-0000-4000-8000-000000000001",
          allowWorkspaceSwitch: true,
          noSessionLog: true,
        },
      }),
    ).toEqual([
      "exec",
      "--json",
      "--model",
      "muse-spark-1.2",
      "--reasoning-effort",
      "medium",
      "--workspace",
      "/tmp/repo",
      "--sandbox-network",
      "restricted",
      "--subagent-worktree-isolation",
      "--session-id",
      "00000000-0000-4000-8000-000000000001",
      "--allow-workspace-switch",
      "--max-model-steps",
      "42",
      "--no-session-log",
    ]);
  });

  test("yolo requires explicit muse.yolo", () => {
    expect(h.buildArgs({ skipPermissions: true, muse: { yolo: true } })).toEqual([
      "exec",
      "--json",
      "--yolo",
      "--trust-workspace",
    ]);
    expect(h.buildArgs({ skipPermissions: true })).not.toContain("--yolo");
  });

  test("disableSandbox requires muse.yolo", () => {
    expect(() => h.buildArgs({ muse: { disableSandbox: true } })).toThrow(
      /disableSandbox requires muse\.yolo/,
    );
    expect(
      h.buildArgs({ muse: { yolo: true, disableSandbox: true } }),
    ).toContain("--disable-sandbox");
  });

  test("rejects unsupported plan mode", () => {
    expect(() => h.buildArgs({ mode: "plan" })).toThrow(/does not support agent mode/);
  });

  test("rejects invalid reasoning effort", () => {
    expect(() =>
      h.buildArgs({ muse: { reasoningEffort: "none" as "minimal" } }),
    ).toThrow(/does not support reasoning effort "none"/);
  });

  test("rejects unknown muse options", () => {
    expect(() => h.buildArgs({ muse: { approvalMode: "auto" } as never })).toThrow(
      /Unknown Muse harness option/,
    );
  });
});

describe("Muse JSONL parser", () => {
  test("parses assistant events incrementally", () => {
    const state = createMuseJsonlParseState();
    const buffer = { partial: "" };
    feedMuseJsonlChunk(
      state,
      buffer,
      '{"type":"assistant","text":"hello"}\n{"type":"assistant","text":" world"}\n',
    );
    flushMuseJsonlBuffer(state, buffer);
    expect(state.textParts.join("")).toBe("hello world");
    expect(state.events).toHaveLength(2);
  });

  test("tolerates unknown events", () => {
    const state = createMuseJsonlParseState();
    parseMuseJsonlLine(state, '{"type":"future_event","payload":{"x":1}}');
    expect(state.events).toHaveLength(1);
    expect(state.textParts).toHaveLength(0);
  });

  test("records malformed lines without throwing", () => {
    const state = createMuseJsonlParseState();
    parseMuseJsonlLine(state, "not-json");
    expect(state.parseErrors).toHaveLength(1);
    expect(state.parseErrors[0]).toContain("Malformed JSONL");
  });

  test("detects step limit events", () => {
    const state = createMuseJsonlParseState();
    parseMuseJsonlLine(state, '{"type":"step_limit_reached","message":"max-model-steps"}');
    expect(state.stepLimitReached).toBe(true);
  });
});

describe("Muse exit code mapping", () => {
  test("maps documented exit codes", () => {
    expect(mapMuseExitState(0)).toBe("completed");
    expect(mapMuseExitState(2)).toBe("usage_error");
    expect(mapMuseExitState(130)).toBe("interrupted");
    expect(mapMuseExitState(143)).toBe("interrupted");
    expect(mapMuseExitState(1, { stepLimitReached: true })).toBe("step_limit");
    expect(mapMuseExitState(0, { stepLimitReached: true })).toBe("step_limit");
    expect(mapMuseExitState(1)).toBe("failed");
  });

  test("detects sandbox failures from stderr", () => {
    expect(
      mapMuseExitState(1, { stderr: "bubblewrap unavailable on musl build" }),
    ).toBe("sandbox_unavailable");
    expect(describeMuseExitState("sandbox_unavailable")).toContain("sandbox");
  });

  test("prefers step_limit over sandbox stderr heuristics", () => {
    expect(
      mapMuseExitState(1, {
        stepLimitReached: true,
        stderr: "bubblewrap unavailable on musl build",
      }),
    ).toBe("step_limit");
  });
});

describe("Muse prompt delivery", () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const file of createdFiles.splice(0)) {
      cleanupMusePromptFile(file);
    }
  });

  test("uses positional prompt for small prompts", () => {
    const delivery = planMusePromptDelivery('say "hello" & $(rm -rf /)');
    expect(delivery.args).toEqual(['say "hello" & $(rm -rf /)']);
    expect(delivery.tempPromptFile).toBeUndefined();
  });

  test("uses prompt file for large prompts and cleans up", () => {
    const big = "x".repeat(9000);
    const delivery = planMusePromptDelivery(big);
    expect(delivery.args[0]).toBe("--prompt-file");
    expect(delivery.tempPromptFile).toBeDefined();
    createdFiles.push(delivery.tempPromptFile!);
    cleanupMusePromptFile(delivery.tempPromptFile);
  });

  test("creates private prompt files", () => {
    const path = createMusePromptFile("secret prompt");
    createdFiles.push(path);
    expect(readFileSync(path, "utf8")).toBe("secret prompt");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const dirMode = statSync(join(path, "..")).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  test("cleanup removes prompt file and parent directory", () => {
    const path = createMusePromptFile("cleanup me");
    const dir = join(path, "..");
    cleanupMusePromptFile(path);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("validateMuseRunOptions", () => {
  const h = new MuseHarness();

  test("requires session id for allowWorkspaceSwitch", () => {
    expect(() =>
      validateMuseRunOptions(h, { muse: { allowWorkspaceSwitch: true } }),
    ).toThrow(/allowWorkspaceSwitch requires muse.sessionId/);
  });
});

describe("runAgentMuse stub integration", () => {
  test("streams JSONL and normalizes stdout via stub executable", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "implement feature X", {
      silent: true,
    });

    expect(result.exitState).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.normalizedText).toContain("Echo: implement feature X");
    expect(result.events.length).toBeGreaterThan(1);
    expect(result.parseErrors).toHaveLength(0);
  });

  test("handles unicode prompts without shell interpolation", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "unicode café 🎉", {
      silent: true,
    });
    expect(result.normalizedText).toContain("café");
  });

  test("maps step limit exit from stub", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "__STEP_LIMIT__", { silent: true });
    expect(result.exitState).toBe("step_limit");
    expect(result.maxTurnsReached).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("normalizes step limit with Muse exit 0 to failure exit code", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "__STEP_LIMIT_EXIT_0__", {
      silent: true,
    });
    expect(result.exitState).toBe("step_limit");
    expect(result.maxTurnsReached).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("maps sandbox unavailable from stub stderr", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "__SANDBOX_FAIL__", { silent: true });
    expect(result.exitState).toBe("sandbox_unavailable");
    expect(result.maxTurnsReached).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test("records CLI version from stub --version", () => {
    const executable = stubExecutable();
    const version = probeMuseCliVersion(executable);
    expect(version).toContain("stub-muse");
  });

  test("returns binary_missing for missing executable", async () => {
    const harness = new MuseHarness();
    const previousRetries = process.env.AGENT_SPAWN_ENOENT_RETRIES;
    process.env.AGENT_SPAWN_ENOENT_RETRIES = "0";

    try {
      const result = await runAgentMuse(harness, "/no/such/muse-binary", "task", {
        silent: true,
      });
      expect(result.exitState).toBe("binary_missing");
      expect(result.stderr).toContain("Muse Code CLI not found");
    } finally {
      if (previousRetries === undefined) {
        delete process.env.AGENT_SPAWN_ENOENT_RETRIES;
      } else {
        process.env.AGENT_SPAWN_ENOENT_RETRIES = previousRetries;
      }
    }
  });

  test("onStdout receives normalized text deltas, not raw JSONL", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const chunks: string[] = [];
    await runAgentMuse(harness, executable, "stream me", {
      silent: true,
      onStdout: (chunk) => chunks.push(chunk),
    });

    const combined = chunks.join("");
    expect(combined).toContain("Echo: stream me");
    for (const chunk of chunks) {
      expect(chunk.trim().startsWith("{")).toBe(false);
      expect(chunk).not.toContain('"type"');
    }
  });

  test("displayRealtime writes normalized text, not raw JSONL", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return originalWrite(chunk as string, ...(args as []));
    }) as typeof process.stdout.write;

    try {
      await runAgentMuse(harness, executable, "realtime output", {
        silent: true,
        displayRealtime: true,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const combined = writes.join("");
    expect(combined).toContain("Echo: realtime output");
    expect(combined).not.toContain('"type":"assistant"');
  });

  test("delivers large prompts via --prompt-file through runAgentMuse", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const previousThreshold = process.env.MUSE_PROMPT_FILE_THRESHOLD_BYTES;
    process.env.MUSE_PROMPT_FILE_THRESHOLD_BYTES = "16";

    try {
      const prompt = "large prompt payload for file delivery";
      const result = await runAgentMuse(harness, executable, prompt, { silent: true });
      expect(result.exitState).toBe("completed");
      expect(result.normalizedText).toContain("large prompt payload");
    } finally {
      if (previousThreshold === undefined) {
        delete process.env.MUSE_PROMPT_FILE_THRESHOLD_BYTES;
      } else {
        process.env.MUSE_PROMPT_FILE_THRESHOLD_BYTES = previousThreshold;
      }
    }
  });

  test("maps timeout to interrupted exit state", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "__DELAY__", {
      silent: true,
      timeoutMinutes: 0.001,
    });
    expect(result.exitState).toBe("interrupted");
    expect(result.exitCode).toBe(143);
  });

  test("returns invalid_config for unsupported agent mode", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "task", {
      silent: true,
      mode: "plan",
    });
    expect(result.exitState).toBe("invalid_config");
    expect(result.stderr).toContain('does not support agent mode "plan"');
  });

  test("handles malformed JSONL and keeps stdout normalized", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const result = await runAgentMuse(harness, executable, "__MALFORMED__", { silent: true });
      expect(result.exitState).toBe("completed");
      expect(result.parseErrors.length).toBeGreaterThan(0);
      expect(result.normalizedText).toContain("recovered after bad line");
      expect(result.stdout).toBe(result.normalizedText);
      expect(result.stdout).not.toContain("not-json");
      expect(result.rawStdout).toContain("not-json");
      expect(warnings.some((w) => w.includes("Muse JSONL parse warning"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("handles partial JSONL chunks across stdout writes", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "__PARTIAL_JSONL__", { silent: true });
    expect(result.exitState).toBe("completed");
    expect(result.normalizedText).toContain("partial text");
    expect(result.stdout).not.toContain('"type"');
    expect(result.rawStdout).toContain('"type":"assistant"');
  });

  test("returns empty stdout when JSONL has no extractable text", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentMuse(harness, executable, "__NO_TEXT__", { silent: true });
    expect(result.exitState).toBe("completed");
    expect(result.stdout).toBe("");
    expect(result.normalizedText).toBe("");
    expect(result.rawStdout).toContain("future_event");
    expect(result.rawStdout).not.toBe("");
  });
});

describe("runAgentBun Muse delegation", () => {
  test("delegates Muse runs to runAgentMuse", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentBun(harness, executable, "via bun runner", { silent: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Echo: via bun runner");
    expect("exitState" in result && result.exitState).toBe("completed");
  });
});

describe("runAgentNode Muse delegation", () => {
  test("delegates Muse runs to runAgentMuse", async () => {
    const harness = new MuseHarness();
    const executable = stubExecutable();
    const result = await runAgentNode(harness, executable, "via node runner", { silent: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Echo: via node runner");
    expect("exitState" in result && result.exitState).toBe("completed");
  });
});

describe("MuseHarness.collectWarnings", () => {
  const h = new MuseHarness();

  test("warns when yolo is enabled", () => {
    const warnings = h.collectWarnings({ skipPermissions: true, muse: { yolo: true } });
    expect(warnings.some((w) => w.includes("--yolo"))).toBe(true);
  });

  test("warns when disable-approval is enabled without yolo", () => {
    const warnings = h.collectWarnings({ skipPermissions: true });
    expect(warnings.some((w) => w.includes("--disable-approval"))).toBe(true);
    expect(warnings.some((w) => w.includes("--yolo"))).toBe(false);
  });

  test("warns when disable-sandbox is enabled", () => {
    const warnings = h.collectWarnings({ muse: { yolo: true, disableSandbox: true } });
    expect(warnings.some((w) => w.includes("--disable-sandbox"))).toBe(true);
  });

  test("warns when subagent worktree isolation is used outside a git repo", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "muse-non-git-"));
    if (isGitWorkspace(nonGitDir)) {
      return;
    }
    const warnings = h.collectWarnings({
      workingDir: nonGitDir,
      muse: { subagentWorktreeIsolation: true },
    });
    expect(warnings.some((w) => w.includes("subagent-worktree-isolation"))).toBe(true);
  });
});

describe("MuseConfigError", () => {
  test("is thrown for unknown options", () => {
    const h = new MuseHarness();
    expect(() => h.buildArgs({ muse: { approvalMode: "always" } as never })).toThrow(
      MuseConfigError,
    );
  });
});

/**
 * Optional live CLI smoke test. Gated on MUSE_SMOKE_TEST=1 and `muse` on PATH.
 */
describe("Muse live smoke (optional)", () => {
  test("runs real muse exec when MUSE_SMOKE_TEST=1", async () => {
    if (process.env.MUSE_SMOKE_TEST !== "1") {
      return;
    }
    const harness = new MuseHarness();
    const result = await runAgentMuse(harness, "muse", 'Reply with exactly "pong".', {
      silent: true,
      maxTurns: 3,
      skipPermissions: true,
    });
    expect(result.exitState).toBe("completed");
    expect(result.normalizedText.length).toBeGreaterThan(0);
  });
});
