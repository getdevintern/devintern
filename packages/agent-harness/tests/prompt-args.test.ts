import { describe, expect, test } from "bun:test";
import { CodexHarness } from "../src/harnesses/codex.js";
import { GrokHarness } from "../src/harnesses/grok.js";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import { buildPromptArgs } from "../src/prompt-args.js";

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
});
