import { describe, expect, test } from "bun:test";
import { getHarness, listHarnesses, registerHarness } from "../src/registry.js";
import { ClaudeCodeHarness } from "../src/harnesses/claude-code.js";

describe("registry", () => {
  test("listHarnesses returns all built-in harnesses", () => {
    const harnesses = listHarnesses();
    expect(harnesses.length).toBe(13);
    const names = harnesses.map((h) => h.name);
    expect(names).toContain("claude-code");
    expect(names).toContain("opencode");
    expect(names).toContain("codex");
    expect(names).toContain("cursor");
    expect(names).toContain("deepseek");
    expect(names).toContain("antigravity");
    expect(names).not.toContain("gemini");
    expect(names).toContain("goose");
    expect(names).toContain("grok");
    expect(names).toContain("kilo-code");
    expect(names).toContain("kimi");
    expect(names).toContain("cline");
    expect(names).toContain("pi");
    expect(names).toContain("qwen");
  });

  test("getHarness returns correct harness", () => {
    const h = getHarness("claude-code");
    expect(h).toBeDefined();
    expect(h!.name).toBe("claude-code");
    expect(h!.displayName).toBe("Claude Code");
  });

  test("getHarness resolves antigravity aliases without listing them separately", () => {
    const byCanonical = getHarness("antigravity");
    const byAgy = getHarness("agy");
    const byGemini = getHarness("gemini");
    expect(byCanonical?.name).toBe("antigravity");
    expect(byAgy).toBe(byCanonical);
    expect(byGemini).toBe(byCanonical);
    expect(byCanonical?.defaultPath).toBe("agy");
  });

  test("getHarness returns undefined for unknown name", () => {
    expect(getHarness("nonexistent")).toBeUndefined();
  });

  test("registerHarness adds a new harness", () => {
    const custom = new ClaudeCodeHarness();
    Object.defineProperty(custom, "name", { value: "custom-claude" });
    registerHarness(custom);

    expect(getHarness("custom-claude")).toBe(custom);

    // Cleanup
    // There is no unregister, but re-registering built-ins is fine
  });
});
