import { describe, expect, test } from "bun:test";
import { parseAgentJsonObject } from "../src/lib/agent-json";

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
