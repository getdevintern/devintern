import { afterEach, describe, expect, test } from "bun:test";

import { InvalidAgentEffortError } from "@devintern/agent-harness";

import { resolveAgentEffort, resolveAgentModel } from "../src/lib/agent-model";

afterEach(() => {
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_EFFORT;
});

describe("resolveAgentModel", () => {
  test("returns undefined when AGENT_MODEL is unset", () => {
    expect(resolveAgentModel()).toBeUndefined();
  });

  test("returns the configured model", () => {
    process.env.AGENT_MODEL = "sonnet";
    expect(resolveAgentModel()).toBe("sonnet");
  });

  test("trims whitespace", () => {
    process.env.AGENT_MODEL = "  qwen3-coder-plus  ";
    expect(resolveAgentModel()).toBe("qwen3-coder-plus");
  });

  test("treats whitespace-only values as unset", () => {
    process.env.AGENT_MODEL = "   ";
    expect(resolveAgentModel()).toBeUndefined();
  });
});

describe("resolveAgentEffort", () => {
  test("returns undefined when AGENT_EFFORT is unset", () => {
    expect(resolveAgentEffort()).toBeUndefined();
  });

  test("returns the configured effort", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      process.env.AGENT_EFFORT = effort;
      expect(resolveAgentEffort()).toBe(effort);
    }
  });

  test("trims whitespace", () => {
    process.env.AGENT_EFFORT = "  high  ";
    expect(resolveAgentEffort()).toBe("high");
  });

  test("treats whitespace-only values as unset", () => {
    process.env.AGENT_EFFORT = "   ";
    expect(resolveAgentEffort()).toBeUndefined();
  });

  test("throws a clear error for invalid values", () => {
    process.env.AGENT_EFFORT = "ultra";
    expect(() => resolveAgentEffort()).toThrow(InvalidAgentEffortError);
    expect(() => resolveAgentEffort()).toThrow(
      /Invalid agent effort "ultra". Valid values: low, medium, high/,
    );
  });
});
