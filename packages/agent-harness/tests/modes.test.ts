import { describe, expect, test } from "bun:test";

import {
  UnsupportedAgentModeError,
  assertModeSupported,
  effectiveSkipPermissions,
  getSupportedModes,
  isConstrainedMode,
  isModeSupported,
} from "../src/modes.js";
import { listHarnesses } from "../src/registry.js";
import { AntigravityHarness } from "../src/harnesses/antigravity.js";
import { ClaudeCodeHarness } from "../src/harnesses/claude-code.js";
import { ClineHarness } from "../src/harnesses/cline.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { CursorHarness } from "../src/harnesses/cursor.js";
import { DeepSeekHarness } from "../src/harnesses/deepseek.js";
import { GooseHarness } from "../src/harnesses/goose.js";
import { GrokHarness } from "../src/harnesses/grok.js";
import { KiloCodeHarness } from "../src/harnesses/kilo-code.js";
import { KimiHarness } from "../src/harnesses/kimi.js";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import { PiHarness } from "../src/harnesses/pi.js";
import { QwenCodeHarness } from "../src/harnesses/qwen.js";

describe("mode helpers", () => {
  test("isConstrainedMode", () => {
    expect(isConstrainedMode(undefined)).toBe(false);
    expect(isConstrainedMode("default")).toBe(false);
    expect(isConstrainedMode("plan")).toBe(true);
    expect(isConstrainedMode("readonly")).toBe(true);
  });

  test("effectiveSkipPermissions ignores skip when constrained", () => {
    expect(effectiveSkipPermissions({ skipPermissions: true })).toBe(true);
    expect(effectiveSkipPermissions({ skipPermissions: true, mode: "default" })).toBe(true);
    expect(effectiveSkipPermissions({ skipPermissions: true, mode: "plan" })).toBe(false);
    expect(effectiveSkipPermissions({ skipPermissions: true, mode: "readonly" })).toBe(false);
    expect(effectiveSkipPermissions({ mode: "plan" })).toBe(false);
  });

  test("assertModeSupported fails closed for unsupported harness", () => {
    const h = new ClineHarness();
    expect(() => assertModeSupported(h, undefined)).not.toThrow();
    expect(() => assertModeSupported(h, "default")).not.toThrow();
    expect(() => assertModeSupported(h, "plan")).toThrow(UnsupportedAgentModeError);
    expect(() => assertModeSupported(h, "readonly")).toThrow(UnsupportedAgentModeError);
  });

  test("getSupportedModes covers all registered harnesses", () => {
    const support = Object.fromEntries(
      listHarnesses().map((h) => [h.name, getSupportedModes(h)]),
    );
    expect(support["claude-code"]).toEqual(["plan", "readonly"]);
    expect(support["codex"]).toEqual(["plan", "readonly"]);
    expect(support["cursor"]).toEqual(["plan", "readonly"]);
    expect(support["grok"]).toEqual(["plan", "readonly"]);
    expect(support["opencode"]).toEqual(["plan", "readonly"]);
    // Antigravity has no headless plan/read-only enforcement (print mode
    // auto-approves all tools) — see the harness doc comment.
    expect(support["antigravity"]).toEqual([]);
    expect(support["cline"]).toEqual([]);
    expect(support["deepseek"]).toEqual([]);
    expect(support["goose"]).toEqual([]);
    expect(support["kilo-code"]).toEqual([]);
    expect(support["kimi"]).toEqual([]);
    expect(support["pi"]).toEqual([]);
    expect(support["qwen"]).toEqual([]);
  });
});

describe("ClaudeCodeHarness modes", () => {
  const h = new ClaudeCodeHarness();

  test("supportedModes", () => {
    expect(getSupportedModes(h)).toEqual(["plan", "readonly"]);
    expect(isModeSupported(h, "plan")).toBe(true);
  });

  test("plan maps to --permission-mode plan without skip-permissions", () => {
    expect(h.buildArgs({ mode: "plan", skipPermissions: true, model: "opus" })).toEqual([
      "--permission-mode",
      "plan",
      "--allowedTools",
      "WebFetch,WebSearch",
      "--model",
      "opus",
    ]);
  });

  test("readonly maps to --permission-mode plan with web tools allowed", () => {
    expect(h.buildArgs({ mode: "readonly" })).toEqual([
      "--permission-mode",
      "plan",
      "--allowedTools",
      "WebFetch,WebSearch",
    ]);
  });

  test("constrained mode appends caller allowedTools after web tools", () => {
    expect(h.buildArgs({ mode: "readonly", allowedTools: ["mcp__notion"] })).toEqual([
      "--permission-mode",
      "plan",
      "--allowedTools",
      "WebFetch,WebSearch,mcp__notion",
    ]);
  });

  test("default mode ignores allowedTools", () => {
    expect(h.buildArgs({ skipPermissions: true, allowedTools: ["mcp__notion"] })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  test("default with skipPermissions unchanged", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("CodexHarness modes", () => {
  const h = new CodexHarness();

  test("plan/readonly use read-only sandbox", () => {
    expect(h.buildArgs({ mode: "plan", skipPermissions: true })).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
    ]);
    expect(h.buildArgs({ mode: "readonly" })).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
    ]);
  });

  test("default skipPermissions still workspace-write", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ]);
  });
});

describe("CursorHarness modes", () => {
  const h = new CursorHarness();

  test("plan uses --mode plan without --force", () => {
    expect(h.buildArgs({ mode: "plan", skipPermissions: true })).toEqual([
      "-p",
      "--mode",
      "plan",
      "--trust",
    ]);
  });

  test("readonly uses --mode ask without --force", () => {
    expect(h.buildArgs({ mode: "readonly", skipPermissions: true })).toEqual([
      "-p",
      "--mode",
      "ask",
      "--trust",
    ]);
  });

  test("default skipPermissions still force", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual([
      "-p",
      "--force",
      "--trust",
      "--approve-mcps",
    ]);
  });
});

describe("AntigravityHarness modes", () => {
  const h = new AntigravityHarness();

  test("plan/readonly fail closed (no headless enforcement in agy)", () => {
    expect(() => h.buildArgs({ mode: "plan" })).toThrow(UnsupportedAgentModeError);
    expect(() => h.buildArgs({ mode: "readonly", skipPermissions: true })).toThrow(
      UnsupportedAgentModeError,
    );
  });

  test("default skipPermissions uses --dangerously-skip-permissions", () => {
    expect(h.buildArgs({ skipPermissions: true })).toEqual(["--dangerously-skip-permissions"]);
    expect(h.buildArgs({})).toEqual([]);
  });
});

describe("GrokHarness modes", () => {
  const h = new GrokHarness();

  test("plan/readonly use --permission-mode plan without always-approve", () => {
    expect(h.buildArgs({ mode: "plan", skipPermissions: true })).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "plan",
    ]);
    expect(h.buildArgs({ mode: "readonly" })).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "plan",
    ]);
  });
});

describe("OpencodeHarness modes", () => {
  const h = new OpencodeHarness();

  test("plan/readonly use --agent plan without skip-permissions", () => {
    expect(h.buildArgs({ mode: "plan", skipPermissions: true, workingDir: "/tmp/wt" })).toEqual([
      "run",
      "--agent",
      "plan",
      "--dir",
      "/tmp/wt",
    ]);
    expect(h.buildArgs({ mode: "readonly" })).toEqual(["run", "--agent", "plan"]);
  });
});

describe("unsupported harnesses fail closed", () => {
  const cases = [
    new ClineHarness(),
    new DeepSeekHarness(),
    new GooseHarness(),
    new KiloCodeHarness(),
    new KimiHarness(),
    new PiHarness(),
    new QwenCodeHarness(),
  ];

  for (const h of cases) {
    test(`${h.name} throws on plan mode`, () => {
      expect(() => h.buildArgs({ mode: "plan" })).toThrow(UnsupportedAgentModeError);
    });
    test(`${h.name} throws on readonly mode`, () => {
      expect(() => h.buildArgs({ mode: "readonly" })).toThrow(UnsupportedAgentModeError);
    });
    test(`${h.name} default path unchanged`, () => {
      // Should not throw for default
      expect(() => h.buildArgs({})).not.toThrow();
    });
  }
});
