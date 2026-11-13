import { describe, expect, test } from "bun:test";
import { parseAgentJsonObject } from "../src/lib/agent/json";

describe("parseAgentJsonObject", () => {
  test("parses fenced JSON", () => {
    expect(parseAgentJsonObject('```json\n{"approved": true}\n```', "approved")).toEqual({
      approved: true,
    });
  });

  test("parses bare JSON returned by Codex", () => {
    const output = `{
  "isImplementable": true,
  "clarityScore": 8,
  "issues": [],
  "recommendations": [],
  "summary": "The task is implementable."
}`;

    expect(parseAgentJsonObject(output, "isImplementable")).toEqual({
      isImplementable: true,
      clarityScore: 8,
      issues: [],
      recommendations: [],
      summary: "The task is implementable.",
    });
  });

  test("parses JSON surrounded by narration and unrelated braces", () => {
    const output = `I checked PATCH /items/{id} first.
{"approved":false,"summary":"A string with {braces}","items":[]}
That is the final review.`;

    expect(parseAgentJsonObject(output, "approved")).toEqual({
      approved: false,
      summary: "A string with {braces}",
      items: [],
    });
  });

  test("prefers the last matching bare object", () => {
    const output = '{"storyPoints":1}\nFinal: {"storyPoints":5,"confidence":"high"}';
    expect(parseAgentJsonObject(output, "storyPoints")).toEqual({
      storyPoints: 5,
      confidence: "high",
    });
  });

  test("repairs raw newlines inside JSON string values", () => {
    const output = [
      "```json",
      "{",
      '  "approved": true,',
      '  "summary": "## Notes',
      "",
      "Looks good with `code/` changes.",
      '"',
      "}",
      "```",
    ].join("\n");

    expect(parseAgentJsonObject(output, "approved")).toEqual({
      approved: true,
      summary: "## Notes\n\nLooks good with `code/` changes.\n",
    });
  });

  test("escapes unescaped double quotes inside string values", () => {
    const output = [
      "```json",
      "{",
      '  "approved": true,',
      '  "summary": "A legacy "cwd" mode mutates the repo."',
      "}",
      "```",
    ].join("\n");

    expect(parseAgentJsonObject(output, "approved")).toEqual({
      approved: true,
      summary: 'A legacy "cwd" mode mutates the repo.',
    });
  });

  test("escapes unescaped quotes inside pasted code with brackets", () => {
    // Regression: a verification verdict was rejected because its summary
    // quoted `["headless", prompt]`. The quote before the comma looked like the
    // end of the string, so the object was never balanced and the run failed
    // verification twice with "no valid JSON object containing approved".
    const summary =
      'The adapter emits ["headless", prompt] with no warnings, and `dsh headless --help` matches.';
    // The inner quotes are intentionally unescaped, exactly as the model wrote them.
    const output = `{"summary":"${summary}","items":[],"approved":true}`;

    expect(parseAgentJsonObject(output, "approved")).toEqual({
      summary,
      items: [],
      approved: true,
    });
  });

  test("tolerates literal \\n junk between the final value and the closing brace", () => {
    const output = "Narration." + String.raw`{"approved": true, "summary": "D."\n}`;
    expect(parseAgentJsonObject(output, "approved")).toEqual({
      approved: true,
      summary: "D.",
    });
  });

  test("throws when the expected object is absent", () => {
    expect(() => parseAgentJsonObject("No structured response.", "approved")).toThrow(
      'No valid JSON object containing "approved"',
    );
  });
});

describe("JSON recovery across plain-text harness outputs", () => {
  const verdict = { summary: "Checked", items: [], approved: false };

  test.each([
    [
      "truncated package JSON",
      '$ cat package.json | head -3\n{\n  "name": "example",\n  "scripts": {',
    ],
    ["truncated string", '{"description":"unfinished'],
    ["source snippet", "function example() {\n  const value = {"],
    ["terminal formatting", "\u001b[0mTool output: {\n\u001b[0m"],
  ])("recovers a final verdict after %s", (_label, prefix) => {
    expect(parseAgentJsonObject(`${prefix}\n${JSON.stringify(verdict)}`, "approved")).toEqual(
      verdict,
    );
  });

  test("does not infer a missing approval from prose", () => {
    expect(() =>
      parseAgentJsonObject('{"summary":"approved is false","items":[]}', "approved"),
    ).toThrow('No valid JSON object containing "approved"');
  });

  test("keeps the complete outer verdict rather than a nested approval", () => {
    const outer = { approved: false, detail: { approved: true } };
    expect(parseAgentJsonObject(`truncated {\n${JSON.stringify(outer)}`, "approved")).toEqual(
      outer,
    );
  });
});
