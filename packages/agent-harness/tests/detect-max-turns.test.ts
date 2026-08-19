import { describe, expect, test } from "bun:test";

import {
  detectMaxTurnsReached,
  findMaxTurnsReachedLine,
} from "../src/detect-max-turns.js";

describe("detectMaxTurnsReached", () => {
  test("detects Claude Code stdout message", () => {
    expect(detectMaxTurnsReached("Error: Reached max turns (1)\n", "")).toBe(true);
    expect(findMaxTurnsReachedLine("Error: Reached max turns (1)\n", "")).toBe(
      "Error: Reached max turns (1)",
    );
  });

  test("detects message on stderr", () => {
    expect(detectMaxTurnsReached("", "Reached max turns")).toBe(true);
  });

  test("detects alternate phrasing", () => {
    expect(detectMaxTurnsReached("", "maximum turns reached")).toBe(true);
  });

  test("does not match CLI flag alone", () => {
    expect(detectMaxTurnsReached("claude -p --max-turns 10\n", "")).toBe(false);
  });

  test("returns false for normal output", () => {
    expect(detectMaxTurnsReached("Hello! How can I help you today?\n", "")).toBe(false);
  });

  test("skips scanning when the harness cannot impose a turn limit", () => {
    expect(detectMaxTurnsReached("Error: Reached max turns (1)\n", "", false)).toBe(false);
  });

  test("ignores the phrase inside this repo's source and lint dumps", () => {
    const transcript = [
      `@getdevintern/code lint:  3445 │ │                         \`\\n🔄 Moving \${taskKey} back to '\${todoStatus}' due to max turns reached...\`,`,
      "  /max turns reached/i,",
      '    console.log("⚠️  Agent reached maximum turns limit without completing the task");',
      "              // Check if Agent reached max turns or had other issues",
    ].join("\n");

    expect(detectMaxTurnsReached(transcript, "")).toBe(false);
    expect(detectMaxTurnsReached("", transcript)).toBe(false);
  });

  test("ignores compact diff additions", () => {
    const diff = [
      "diff --git a/packages/code/src/index.ts b/packages/code/src/index.ts",
      `+                      \`\\n🔄 Moving \${taskKey} back to '\${todoStatus}' due to max turns reached...\`,`,
    ].join("\n");

    expect(detectMaxTurnsReached("", diff)).toBe(false);
  });

  test("ignores file-location search output", () => {
    const source = "packages/code/src/index.ts:3445:due to max turns reached...";

    expect(detectMaxTurnsReached(source, "")).toBe(false);
    expect(detectMaxTurnsReached("", source)).toBe(false);
  });
});
