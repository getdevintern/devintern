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

describe("parseAgentJson object-literal drift repairs", () => {
  test("strips line comments inside the object", () => {
    const raw = [
      "{",
      "  // story below",
      '  "summary": "S",',
      '  "description": "URLs like https://x.io/a//b survive comment stripping",',
      "",
      "  ## note",
      "}",
    ].join("\n");
    const parsed = parseAgentJson<Record<string, string>>(raw);
    expect(parsed.summary).toBe("S");
    expect(parsed.description).toBe("URLs like https://x.io/a//b survive comment stripping");
  });

  test("strips block comments inside the object", () => {
    const raw = '{ /* draft */ "summary": "S", "description": "D" }';
    expect(parseAgentJson<Record<string, string>>(raw).summary).toBe("S");
  });

  test("removes trailing commas", () => {
    const raw = '{"summary": "S", "description": "D",}';
    expect(parseAgentJson<Record<string, string>>(raw)).toEqual({
      summary: "S",
      description: "D",
    });
  });

  test("quotes unquoted JavaScript-style keys", () => {
    const raw = '{ summary: "S", description: "D, with punctuation: plenty" }';
    expect(parseAgentJson<Record<string, string>>(raw)).toEqual({
      summary: "S",
      description: "D, with punctuation: plenty",
    });
  });

  test("quotes single-quoted keys", () => {
    const raw = `{ 'summary': "S", 'description': "D" }`;
    expect(parseAgentJson<Record<string, string>>(raw)).toEqual({
      summary: "S",
      description: "D",
    });
  });

  test("normalizes smart-quoted keys", () => {
    const raw = '{"summary": "S", \u201cdescription\u201d: "D"}';
    expect(parseAgentJson<Record<string, string>>(raw)).toEqual({
      summary: "S",
      description: "D",
    });
  });

  test("salvages values whose inner prose quotes desync every heuristic", () => {
    // `Pick "one", then "two"` defeats structural quote repair because commas
    // follow the quoted words — the schema-key salvage rebuilds the payload.
    const raw = [
      "{",
      '  "summary": "Story generation fails",',
      '  "description": "Pick "one", then "two", then done"',
      "}",
    ].join("\n");
    const parsed = parseAgentJson<Record<string, string>>(raw);
    expect(parsed.summary).toBe("Story generation fails");
    expect(parsed.description).toContain("then done");
  });

  test("salvages a richly formatted description mixing several failure shapes", () => {
    // Reconstruction of the DEV-100 report class: comments, unquoted keys,
    // literal newlines, and stray quotes around long markdown descriptions.
    const raw = [
      "Parsing the requirements now...",
      "{",
      "  // generated draft",
      "  summary: Story creation fails when output isn't clean JSON",
      '  "description": ## Problem',
      "",
      'Some users see "Failed to parse story from agent output".',
      "- Retry the command",
      "- Or switch harness/model",
      "}",
    ].join("\n");
    const parsed = parseAgentJson<Record<string, string>>(raw);
    expect(parsed.summary).toBe("Story creation fails when output isn't clean JSON");
    expect(parsed.description).toContain('"Failed to parse story');
    expect(parsed.description).toContain("- Or switch harness/model");
  });

  test("does not mistake prose for keys during salvage", () => {
    // No known keys anywhere -> salvage yields nothing, parse still throws.
    expect(() =>
      parseAgentJson("I could not produce anything useful. total: 42 failure."),
    ).toThrow();
  });
});
