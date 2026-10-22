import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CodexHarness } from "../src/harnesses/codex.js";
import { GrokHarness } from "../src/harnesses/grok.js";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import { buildPromptArgs, MAX_PROMPT_ARG_BYTES } from "../src/prompt-args.js";

/** Pull the temp prompt path out of the bootstrap prompt. */
function promptFilePath(argv: string[]): string {
  const match = argv.join("\n").match(/\/\S*devintern-prompts\/[0-9a-f]{16}\.md/);
  if (!match) {
    throw new Error(`no oversized-prompt path in: ${argv.join(" | ")}`);
  }
  return match[0];
}

describe("buildPromptArgs", () => {
  test("uses promptFlag when the harness defines one", () => {
    expect(buildPromptArgs(new GrokHarness(), "do the task")).toEqual(["-p", "do the task"]);
  });

  test("falls back to a positional argument", () => {
    expect(buildPromptArgs(new OpencodeHarness(), "do the task")).toEqual(["do the task"]);
  });

  test("emits the end-of-options marker before a dash-leading positional prompt", () => {
    expect(buildPromptArgs(new OpencodeHarness(), "---\ntype: Task\n---\nImplement")).toEqual([
      "--",
      "---\ntype: Task\n---\nImplement",
    ]);
    expect(buildPromptArgs(new CodexHarness(), "- bullet one")).toEqual(["--", "- bullet one"]);
  });

  test("does not emit the marker for prompts that do not start with a dash", () => {
    expect(buildPromptArgs(new OpencodeHarness(), "do the task")).toEqual(["do the task"]);
  });

  test("hands an oversized prompt over as a file instead of an argv entry", () => {
    const prompt = `Review this diff:\n${"x".repeat(MAX_PROMPT_ARG_BYTES)}\n`;
    const args = buildPromptArgs(new OpencodeHarness(), prompt);

    expect(args).toHaveLength(1);
    expect(Buffer.byteLength(args[0]!, "utf8")).toBeLessThan(MAX_PROMPT_ARG_BYTES);
    expect(args[0]).toContain("Read that file in full");
    expect(readFileSync(promptFilePath(args), "utf8")).toBe(prompt);
  });

  test("keeps the prompt flag when the oversized prompt is externalized", () => {
    const args = buildPromptArgs(new GrokHarness(), "y".repeat(MAX_PROMPT_ARG_BYTES + 1));

    expect(args[0]).toBe("-p");
    expect(Buffer.byteLength(args[1]!, "utf8")).toBeLessThan(MAX_PROMPT_ARG_BYTES);
    expect(args[1]).toContain("devintern-prompts");
  });

  test("measures the argv limit in bytes so multibyte prompts are externalized", () => {
    const prompt = "é".repeat(70_000); // 70k characters, ~140 KB of UTF-8.
    expect(prompt.length).toBeLessThan(MAX_PROMPT_ARG_BYTES);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(MAX_PROMPT_ARG_BYTES);

    const args = buildPromptArgs(new OpencodeHarness(), prompt);
    expect(args).toHaveLength(1);
    expect(args[0]).not.toBe(prompt);
    expect(readFileSync(promptFilePath(args), "utf8")).toBe(prompt);
  });

  test("reuses the same file for an identical oversized prompt", () => {
    const prompt = "z".repeat(MAX_PROMPT_ARG_BYTES + 1);
    expect(promptFilePath(buildPromptArgs(new OpencodeHarness(), prompt))).toBe(
      promptFilePath(buildPromptArgs(new OpencodeHarness(), prompt)),
    );
  });
});
