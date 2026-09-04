import { afterEach, describe, expect, test } from "bun:test";

import { resolveAgentModel } from "../src/lib/agent-model";

afterEach(() => {
  delete process.env.AGENT_MODEL;
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
