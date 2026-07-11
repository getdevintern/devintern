import { describe, expect, test } from "bun:test";

import { parseAgentJson } from "./lib/agent-json";

describe("parseAgentJson", () => {
  test("parses a fenced json block", () => {
    const raw = 'Here you go:\n```json\n{"summary": "S", "description": "D"}\n```\nDone.';
    expect(parseAgentJson<Record<string, unknown>>(raw)).toEqual({
      summary: "S",
      description: "D",
    });
  });

  test("parses bare JSON output", () => {
    expect(parseAgentJson<Record<string, unknown>>('{"summary": "S"}')).toEqual({ summary: "S" });
  });

  test("parses raw JSON prefixed with narration (grok headless shape)", () => {
    // Observed live: grok prints a narration sentence, then the object with
    // no fence — previously failed with `Unexpected identifier "I"`.
    const raw =
      "I'll explore the codebase for Gemini CLI usage so the story reflects real integration points." +
      '{\n  "summary": "Deprecate Gemini CLI harness",\n  "description": "## Overview\\n\\nBody with ```bash\\nagy -p\\n``` fenced code inside."\n}\n';
    expect(parseAgentJson<Record<string, unknown>>(raw)).toEqual({
      summary: "Deprecate Gemini CLI harness",
      description: "## Overview\n\nBody with ```bash\nagy -p\n``` fenced code inside.",
    });
  });

  test("parses JSON with trailing prose", () => {
    const raw = '{"summary": "S"}\nLet me know if you need changes.';
    expect(parseAgentJson<Record<string, unknown>>(raw)).toEqual({ summary: "S" });
  });

  test("throws when no candidate parses", () => {
    expect(() => parseAgentJson("I could not produce the story.")).toThrow();
  });
});
