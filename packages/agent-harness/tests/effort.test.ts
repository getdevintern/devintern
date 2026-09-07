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
import { PiHarness } from "../src/harnesses/pi.js";
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
      warnEffortUnsupported(new ClaudeCodeHarness(), { effort: "high" });
      warnEffortUnsupported(new ClaudeCodeHarness(), { model: "sonnet", effort: "low" });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("Claude Code (claude-code) does not support reasoning effort");
    expect(warnings[0]).toContain('ignoring effort "high"');
  });

  test("stays silent without effort, for capable harnesses, and when unset", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      warnEffortUnsupported(new ClaudeCodeHarness(), {});
      warnEffortUnsupported(new CodexHarness(), { effort: "medium" });
      warnEffortUnsupported(new PiHarness(), { model: "claude-sonnet-4-6", effort: "low" });
      warnEffortUnsupported(new ClaudeCodeHarness(), { model: "sonnet" });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([]);
  });
});

describe("harness effort capability flags", () => {
  test("supporting harnesses declare supportsEffort", () => {
    expect(new CodexHarness().supportsEffort).toBe(true);
    expect(new PiHarness().supportsEffort).toBe(true);
  });

  test("effort option type covers exactly the documented values", () => {
    const levels: AgentEffort[] = ["low", "medium", "high"];
    expect(levels).toEqual([...AGENT_EFFORTS]);
  });
});
