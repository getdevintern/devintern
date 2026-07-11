import { describe, expect, test } from "bun:test";
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
});
