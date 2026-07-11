import { describe, expect, test } from "bun:test";

import { detectUsageLimit, resetHintToMs } from "../src/detect-usage-limit.js";

describe("resetHintToMs", () => {
  // Fixed "now": 2026-06-02 18:25 local time.
  const now = new Date(2026, 5, 2, 18, 25, 0, 0).getTime();

  test("parses relative hours and minutes", () => {
    expect(resetHintToMs("2h 15m", now)).toBe(now + (2 * 60 + 15) * 60_000);
  });

  test("parses 'in 30 minutes'", () => {
    expect(resetHintToMs("in 30 minutes", now)).toBe(now + 30 * 60_000);
  });

  test("parses seconds (provider retry-after)", () => {
    expect(resetHintToMs("30s", now)).toBe(now + 30_000);
  });

  test("parses a later-today clock time", () => {
    // 7:20pm today is ~55m after 6:25pm.
    const expected = new Date(2026, 5, 2, 19, 20, 0, 0).getTime();
    expect(resetHintToMs("7:20pm (Asia/Ho_Chi_Minh)", now)).toBe(expected);
  });

  test("returns null for a clock time already past today (caller falls back)", () => {
    expect(resetHintToMs("9am", now)).toBeNull();
  });

  test("returns null for an unparseable or empty hint", () => {
    expect(resetHintToMs(undefined, now)).toBeNull();
    expect(resetHintToMs("soon", now)).toBeNull();
  });
});

describe("detectUsageLimit", () => {
  test("detects the Claude Code session-limit message and extracts reset hint", () => {
    const out = "You've hit your session limit · resets 7:20pm (Asia/Ho_Chi_Minh)\n";
    const result = detectUsageLimit(out, "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("7:20pm (Asia/Ho_Chi_Minh)");
    expect(result.matchedLine).toContain("session limit");
  });

  test("detects usage limit reached", () => {
    expect(detectUsageLimit("Claude usage limit reached", "").limited).toBe(true);
  });

  test("detects the fast-limit message with a relative reset hint", () => {
    const result = detectUsageLimit("You've hit your fast limit · resets in 2h 15m", "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("2h 15m");
  });

  test("detects monthly spend limit (no timer reset)", () => {
    const result = detectUsageLimit("You've hit your monthly spend limit.", "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBeUndefined();
  });

  test("detects bare 'usage limit reached'", () => {
    expect(detectUsageLimit("usage limit reached", "").limited).toBe(true);
  });

  test("matches curly-apostrophe variant", () => {
    expect(detectUsageLimit("You’ve hit your session limit", "").limited).toBe(true);
  });

  test("detects 'reached your usage limit' with 'try again' hint", () => {
    const result = detectUsageLimit("You have reached your usage limit. Try again at 9am.", "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("9am");
  });

  test("detects on stderr", () => {
    expect(detectUsageLimit("", "Error: 429 Too Many Requests").limited).toBe(true);
  });

  test("detects rate limit error phrasing", () => {
    expect(detectUsageLimit("rate limit exceeded", "").limited).toBe(true);
  });

  test("returns limited without reset hint when none present", () => {
    const result = detectUsageLimit("You've hit your session limit", "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBeUndefined();
  });

  test("does not match normal output", () => {
    const result = detectUsageLimit("Done! All review comments addressed.", "");
    expect(result.limited).toBe(false);
    expect(result.resetsAt).toBeUndefined();
  });

  test("does not match benign mention of limits in code", () => {
    expect(detectUsageLimit("Added a maxRequests limit to the config.", "").limited).toBe(false);
  });

  // opencode / Vercel AI SDK provider errors
  test("detects opencode AI_RetryError with Too Many Requests", () => {
    const out = "AI_RetryError: Failed after 4 attempts. Last error: Too Many Requests";
    expect(detectUsageLimit(out, "").limited).toBe(true);
  });

  test("detects provider 'Rate limit reached' JSON error", () => {
    const out =
      'Too Many Requests: {"error":{"code":"1302","message":"Rate limit reached for req"}}';
    expect(detectUsageLimit(out, "").limited).toBe(true);
  });

  test("detects rate_limit_error (Anthropic error type)", () => {
    expect(detectUsageLimit('{"type":"rate_limit_error"}', "").limited).toBe(true);
  });

  test("detects quota exceeded", () => {
    expect(detectUsageLimit("Error: quota exceeded for this API key", "").limited).toBe(true);
  });

  test("extracts a retry-after hint", () => {
    const result = detectUsageLimit("Too Many Requests. Retry after 30s", "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("30s");
  });
});
