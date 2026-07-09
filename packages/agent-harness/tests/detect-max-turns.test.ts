import { describe, expect, test } from "bun:test";

import { detectMaxTurnsReached } from "../src/detect-max-turns.js";

describe("detectMaxTurnsReached", () => {
  test("detects Claude Code stdout message", () => {
    expect(detectMaxTurnsReached("Error: Reached max turns (1)\n", "")).toBe(true);
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
});
