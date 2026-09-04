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

  test("detects Codex's usage-limit upgrade message and extracts its reset", () => {
    const out =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:03 PM.";
    const result = detectUsageLimit("", out);
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("6:03 PM");
  });

  test("detects Codex's ERROR:-prefixed usage-limit line from the CLI", () => {
    const out =
      "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:27 PM.";
    const result = detectUsageLimit("", out);
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("4:27 PM");
    expect(result.matchedLine).toContain("You've hit your usage limit");
  });

  test("detects Codex named limits, workspace credits, and spend caps", () => {
    const messages = [
      "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 8:10 PM.",
      "Your workspace is out of credits. Add credits to continue.",
      "Your workspace is out of credits. Ask your workspace owner to add credits.",
      "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
      "You hit your spend cap set in your workspace. Ask your workspace owner to increase the spend cap.",
      "Quota exceeded. Check your plan and billing details.",
      "To use Codex with your ChatGPT plan, upgrade to Plus at https://chatgpt.com/pricing.",
    ];

    for (const message of messages) {
      expect(detectUsageLimit("", message).limited).toBe(true);
    }
  });

  test("detects current Claude Code credit and allocation exhaustion messages", () => {
    const messages = [
      "You're out of usage credits",
      "Your org is out of usage · add funds to continue",
      "Your org is out of usage · contact your admin",
      "Your seat type doesn't include usage credits",
      "Your usage allocation has been disabled by your admin",
      "Your group's usage limit is set to $0",
      "You're out of extra usage",
      "You've hit your Opus limit · resets in 3h 20m",
      "You've reached your Fable 5 limit · resets at 9pm",
    ];

    for (const message of messages) {
      expect(detectUsageLimit(message, "").limited).toBe(true);
    }
  });

  test("detects on stderr", () => {
    expect(detectUsageLimit("", "Error: 429 Too Many Requests").limited).toBe(true);
  });

  test("detects an API error prefix on stderr", () => {
    expect(detectUsageLimit("", "API Error: 429 Too Many Requests").limited).toBe(true);
  });

  test("detects Qwen's bracketed headless 429 wrapper", () => {
    expect(detectUsageLimit("", "[API Error: 429 status code (no body)]").limited).toBe(true);
  });

  test("detects Grok Build account and team rate-limit messages", () => {
    const messages = [
      "You’ve hit the rate limit for your plan. Upgrade your account or try again later.",
      "You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later. See https://docs.x.ai/developers/rate-limits#rate-limit-tiers",
      "You’ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build",
      "resource-exhausted: Too many requests for team abc. See https://console.x.ai/team/default/rate-limits.",
    ];

    for (const message of messages) {
      expect(detectUsageLimit("", message).limited).toBe(true);
    }
  });

  test("detects Goose credits exhaustion despite its successful exit", () => {
    const out = "Error: Credits exhausted: Insufficient credits to complete this request";
    expect(detectUsageLimit("", out).limited).toBe(true);
  });

  test("detects an HTTP 429 diagnostic on stdout", () => {
    expect(detectUsageLimit("HTTP 429: Too Many Requests", "").limited).toBe(true);
  });

  test("ignores HTTP-like text in source code and does not borrow its retry hint", () => {
    const source = [
      'const isQuickTunnelRateLimited = stderrOutput.includes("429 Too Many Requests");',
      '"Cloudflare Quick Tunnel creation was rate limited. Try again in a few minutes, or use a named tunnel if you need more reliable access."',
    ].join("\n");
    const result = detectUsageLimit(source, "");
    expect(result.limited).toBe(false);
    expect(result.resetsAt).toBeUndefined();
  });

  test("ignores provider-like prose quoted from a Markdown file", () => {
    const source =
      "> 3. What should a limited request receive? 429 with Retry-After is standard, " +
      "but the mobile client does not handle 429 and will surface a generic error.";

    expect(detectUsageLimit(source, "").limited).toBe(false);
    expect(detectUsageLimit("", source).limited).toBe(false);
  });

  test("ignores provider-like content in file-location search output", () => {
    const source = "docs/troubleshooting.md:43:Claude usage limit reached; retry later.";

    expect(detectUsageLimit(source, "").limited).toBe(false);
    expect(detectUsageLimit("", source).limited).toBe(false);
  });

  test("ignores usage-limit phrases in source emitted by Codex tools", () => {
    const source = [
      '    super(`Agent usage limit reached${resetHint ? ` (resets ${resetHint})` : ""}`);',
      'throw new Error("Claude usage limit reached");',
      '"usage limit reached"',
      "The previous run reported Claude usage limit reached but recovered.",
      "Agent usage limit reached. Stopping; will retry on the next scheduled run.",
    ].join("\n");

    expect(detectUsageLimit(source, "").limited).toBe(false);
    // Codex writes its formatted tool transcript to stderr.
    expect(detectUsageLimit("", source).limited).toBe(false);
  });

  test("ignores Codex and Claude exhaustion phrases embedded in transcript prose", () => {
    const transcript = [
      "The fixture says Your workspace is out of credits. Add credits to continue.",
      "Expected: You're out of usage credits; received: socket closed.",
      'const message = "Your org is out of usage · contact your admin";',
    ].join("\n");

    expect(detectUsageLimit("", transcript).limited).toBe(false);
  });

  test("ignores compact diff additions without whitespace after the marker", () => {
    const diff = '+throw new Error("Claude usage limit reached");';

    expect(detectUsageLimit("", diff).limited).toBe(false);
  });

  test("ignores provider-like prose on stderr", () => {
    const source = "The test expects Too Many Requests but received a socket error.";

    expect(detectUsageLimit("", source).limited).toBe(false);
  });

  test("ignores TUI limit phrases embedded in source and prose", () => {
    const transcript = [
      'const message = "[API Error: 429 status code (no body)]";',
      "The fixture expects Credits exhausted: Insufficient credits to complete this request.",
      "A document quotes the Grok rate limit for your plan.",
    ].join("\n");

    expect(detectUsageLimit("", transcript).limited).toBe(false);
  });

  test("ignores a test count containing 429", () => {
    expect(detectUsageLimit("Ran 429 tests across 47 files.", "").limited).toBe(false);
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

  test("detects OpenCode Go's five-hour usage limit and reset hint", () => {
    const out = "AI_APICallError: 5-hour usage limit reached. Resets in 4hr 9min.";
    const result = detectUsageLimit("", out);
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("4hr 9min");
  });

  test("extracts a usage limit from OpenCode's printed structured log", () => {
    const out =
      'timestamp=2026-08-26T14:10:30.957Z level=ERROR run=be653f66 message="stream error" providerID=opencode-go modelID=glm-5.3 error.error="AI_APICallError: 5-hour usage limit reached. Resets in 4hr 9min."';
    const result = detectUsageLimit("", out);
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("4hr 9min");
    expect(result.matchedLine).toBe(out);
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

  test("detects Antigravity individual quota and its adjacent reset line", () => {
    const out = [
      "⚠ Individual quota reached. Please upgrade your subscription to increase your limits.",
      "Resets in 143h57m55s.",
    ].join("\n");
    const result = detectUsageLimit("", out);
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("143h57m55s");
  });

  test("detects Antigravity RESOURCE_EXHAUSTED quota diagnostics", () => {
    const out =
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in 167h39m40s.";
    const result = detectUsageLimit("", out);
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("167h39m40s");
  });

  test("detects Kilo gateway insufficient-balance diagnostics", () => {
    const messages = [
      "Error: Insufficient balance. Please add credits to continue.",
      '{"error":{"message":"Insufficient balance. Please add credits to continue.","code":402}}',
    ];

    for (const message of messages) {
      expect(detectUsageLimit("", message).limited).toBe(true);
    }
  });

  test("does not borrow a non-adjacent reset from transcript content", () => {
    const out = [
      "⚠ Individual quota reached. Please upgrade your subscription to increase your limits.",
      "The task inspected retry scheduling behavior.",
      "Resets in 143h57m55s.",
    ].join("\n");
    const result = detectUsageLimit(out, "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBeUndefined();
  });

  test("ignores balance language embedded in source and prose", () => {
    const out = [
      'const error = "Insufficient balance. Please add credits to continue.";',
      "The docs explain that insufficient balance may require adding credits.",
    ].join("\n");
    expect(detectUsageLimit("", out).limited).toBe(false);
  });

  test("extracts a retry-after hint", () => {
    const result = detectUsageLimit("Too Many Requests. Retry after 30s", "");
    expect(result.limited).toBe(true);
    expect(result.resetsAt).toBe("30s");
  });
});
