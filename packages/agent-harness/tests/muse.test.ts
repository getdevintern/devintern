import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";

import { MuseHarness } from "../src/harnesses/muse.js";
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
    expect(mapMuseExitState(1)).toBe("failed");
  });

  test("detects sandbox failures from stderr", () => {
    expect(
      mapMuseExitState(1, { stderr: "bubblewrap unavailable on musl build" }),
    ).toBe("sandbox_unavailable");
    expect(describeMuseExitState("sandbox_unavailable")).toContain("sandbox");
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

  test("records CLI version from stub --version", () => {
    const executable = stubExecutable();
    const version = probeMuseCliVersion(executable);
    expect(version).toContain("stub-muse");
  });

  test("returns binary_missing for missing executable", async () => {
    const harness = new MuseHarness();
    const result = await runAgentMuse(harness, "/no/such/muse-binary", "task", {
      silent: true,
    });
    expect(result.exitState).toBe("binary_missing");
    expect(result.stderr).toContain("Muse Code CLI not found");
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
