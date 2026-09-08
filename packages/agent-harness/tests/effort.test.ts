import { describe, expect, test } from "bun:test";

import {
  AGENT_EFFORTS,
  InvalidAgentEffortError,
  isAgentEffort,
  parseAgentEffort,
  warnEffortUnsupported,
} from "../src/effort.js";
import { ClaudeCodeHarness } from "../src/harnesses/claude-code.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { ClineHarness } from "../src/harnesses/cline.js";
import { AntigravityHarness } from "../src/harnesses/antigravity.js";
import { DeepSeekHarness } from "../src/harnesses/deepseek.js";
import { GooseHarness } from "../src/harnesses/goose.js";
import { GrokHarness } from "../src/harnesses/grok.js";
import { KiloCodeHarness } from "../src/harnesses/kilo-code.js";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import { PiHarness } from "../src/harnesses/pi.js";
import { QwenCodeHarness } from "../src/harnesses/qwen.js";
import { CursorHarness } from "../src/harnesses/cursor.js";
import { KimiHarness } from "../src/harnesses/kimi.js";
import type { AgentEffort } from "../src/types.js";

describe("AGENT_EFFORTS", () => {
  test("documented set of valid values", () => {
    expect([...AGENT_EFFORTS]).toEqual(["low", "medium", "high"]);
  });
});

describe("isAgentEffort", () => {
  test("accepts documented values", () => {
    for (const effort of AGENT_EFFORTS) {
      expect(isAgentEffort(effort)).toBe(true);
    }
  });

  test("rejects unknown values and non-strings", () => {
    expect(isAgentEffort("minimal")).toBe(false);
    expect(isAgentEffort("HIGH")).toBe(false);
    expect(isAgentEffort("")).toBe(false);
    expect(isAgentEffort(42)).toBe(false);
    expect(isAgentEffort(undefined)).toBe(false);
    expect(isAgentEffort(null)).toBe(false);
  });
});

describe("parseAgentEffort", () => {
  test("returns undefined for unset/blank values (not configured)", () => {
    expect(parseAgentEffort(undefined)).toBeUndefined();
    expect(parseAgentEffort("")).toBeUndefined();
    expect(parseAgentEffort("   ")).toBeUndefined();
    expect(parseAgentEffort(null)).toBeUndefined();
  });

  test("trims and returns valid values", () => {
    expect(parseAgentEffort("low")).toBe("low");
    expect(parseAgentEffort("  medium  ")).toBe("medium");
    expect(parseAgentEffort("high")).toBe("high");
  });

  test("throws InvalidAgentEffortError with the accepted values on invalid input", () => {
    expect(() => parseAgentEffort("ultra")).toThrow(InvalidAgentEffortError);
    expect(() => parseAgentEffort("ultra")).toThrow(
      /Invalid agent effort "ultra". Valid values: low, medium, high/,
    );
    expect(() => parseAgentEffort("High")).toThrow(InvalidAgentEffortError);
  });
});

describe("warnEffortUnsupported", () => {
  test("warns when effort is set on a harness without support", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      warnEffortUnsupported(new CursorHarness(), { effort: "high" });
      warnEffortUnsupported(new CursorHarness(), { model: "claude-3", effort: "low" });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("Cursor (cursor) does not support reasoning effort");
    expect(warnings[0]).toContain('ignoring effort "high"');
  });

  test("stays silent without effort, for capable harnesses, and when unset", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      warnEffortUnsupported(new CursorHarness(), {});
      warnEffortUnsupported(new CodexHarness(), { effort: "medium" });
      warnEffortUnsupported(new PiHarness(), { model: "claude-sonnet-4-6", effort: "low" });
      warnEffortUnsupported(new ClaudeCodeHarness(), { model: "sonnet", effort: "low" });
      warnEffortUnsupported(new CursorHarness(), { model: "claude-3" });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([]);
  });
});

describe("harness effort capability flags", () => {
  test("supporting harnesses declare supportsEffort", () => {
    expect(new AntigravityHarness().supportsEffort).toBe(true);
    expect(new ClaudeCodeHarness().supportsEffort).toBe(true);
    expect(new ClineHarness().supportsEffort).toBe(true);
    expect(new CodexHarness().supportsEffort).toBe(true);
    expect(new DeepSeekHarness().supportsEffort).toBe(true);
    expect(new GrokHarness().supportsEffort).toBe(true);
    expect(new KiloCodeHarness().supportsEffort).toBe(true);
    expect(new OpencodeHarness().supportsEffort).toBe(true);
    expect(new PiHarness().supportsEffort).toBe(true);
  });

  test("harnesses without a per-run effort mechanism stay unsupported", () => {
    // Cursor: effort only via model-string bracket params, which the CLI
    // `--model` flag does not support. Goose: `GOOSE_THINKING_EFFORT`
    // env/config only, no `goose run` flag. Qwen: `/effort` slash command and
    // `model.reasoningEffort` setting, no headless CLI flag. Kimi: boolean
    // `--thinking` toggle only, no effort levels.
    expect(new CursorHarness().supportsEffort).toBeUndefined();
    expect(new GooseHarness().supportsEffort).toBeUndefined();
    expect(new QwenCodeHarness().supportsEffort).toBeUndefined();
    expect(new KimiHarness().supportsEffort).toBeUndefined();
  });

  test("effort option type covers exactly the documented values", () => {
    const levels: AgentEffort[] = ["low", "medium", "high"];
    expect(levels).toEqual([...AGENT_EFFORTS]);
  });
});
