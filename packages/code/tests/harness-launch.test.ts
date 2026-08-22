import { describe, expect, test } from "bun:test";

import {
  AgentLaunchError,
  classifyExitFailure,
  detectAuthFailure,
  executableMissingError,
  hasMeaningfulAgentOutput,
  isFallbackEligible,
  sanitizeFallbackReason,
  spawnFailedError,
} from "../src/lib/harness-launch";

describe("detectAuthFailure", () => {
  test("recognizes common harness authentication failures", () => {
    const samples = [
      "error: Invalid API key provided",
      "claude: API key is missing. Set ANTHROPIC_API_KEY.",
      "Not logged in. Run `codex login` first.",
      "You need to log in to continue",
      "Authentication failed: 401 Unauthorized",
      "credentials not found; please run opencode auth login",
      "access token expired",
      "Please run /login to authenticate",
    ];
    for (const sample of samples) {
      expect(detectAuthFailure(sample, "")).toBe(true);
      expect(detectAuthFailure("", sample)).toBe(true);
    }
  });

  test("does not flag unrelated startup diagnostics", () => {
    const benign = [
      "Starting session...",
      "Loaded 12 MCP tools",
      "Reading task file TASK-123",
      "the agent later wrote docs about api key rotation (see src/auth.ts)",
      "Warning: deprecation of legacy config keys",
    ];
    for (const sample of benign) {
      expect(detectAuthFailure(sample, "")).toBe(false);
    }
  });
});

describe("hasMeaningfulAgentOutput", () => {
  test("empty output is not meaningful", () => {
    expect(hasMeaningfulAgentOutput("")).toBe(false);
    expect(hasMeaningfulAgentOutput("   \n\t")).toBe(false);
  });

  test("startup banners and diagnostics are not meaningful", () => {
    const bannerOnly = [
      "Welcome to Claude Code!",
      "v1.2.3",
      "Model: claude-sonnet-4-5",
      "Session: abc123",
      "─────────────────────",
      "Tip: use /help for commands",
      "",
    ].join("\n");
    expect(hasMeaningfulAgentOutput(bannerOnly)).toBe(false);
  });

  test("authentication error text alone stays fallback-eligible", () => {
    expect(hasMeaningfulAgentOutput("Invalid API key provided. Please check credentials.")).toBe(
      false,
    );
  });

  test("task-related agent output is meaningful", () => {
    const taskOutput =
      "I'll implement the login feature.\n\n" +
      "Created src/login.ts with a form component that validates the email address and " +
      "password fields before submitting the request to the authentication endpoint.";
    expect(hasMeaningfulAgentOutput(taskOutput)).toBe(true);
  });

  test("ANSI styling does not create meaningfulness", () => {
    const ansiBanner = "\x1b[32m✻ Welcome\x1b[0m\n\x1b[1mSession: abc123\x1b[0m";
    expect(hasMeaningfulAgentOutput(ansiBanner)).toBe(false);
  });
});

describe("classifyExitFailure", () => {
  test("auth failure before output is fallback eligible", () => {
    expect(classifyExitFailure("", "Invalid API key")).toBe("auth-failed");
    expect(classifyExitFailure("Not logged in\n", "")).toBe("auth-failed");
  });

  test("non-zero exit before any output falls back as exited-before-output", () => {
    expect(classifyExitFailure("", "")).toBe("exited-before-output");
    expect(classifyExitFailure("Loading plugins...\n", "warn: deprecated flag")).toBe(
      "exited-before-output",
    );
  });

  test("exit after meaningful stdout never falls back", () => {
    const meaningful =
      "I edited src/index.ts to add the retry loop around the spawn call, updated the existing " +
      "unit tests to cover transient ENOENT failures, and extended the docs with a short note.";
    expect(hasMeaningfulAgentOutput(meaningful)).toBe(true);
    expect(classifyExitFailure(meaningful, "")).toBeNull();
  });

  test("meaningful output wins even when it mentions auth vocabulary", () => {
    const transcript =
      "Discussed how the api key rotation should work, wrote examples into docs/auth.md, " +
      "and added unit tests covering token expiry handling for the scheduled refresher job.";
    expect(classifyExitFailure(transcript, "exit status 3")).toBeNull();
  });

  test("verbose multi-line auth errors on stdout still fall back", () => {
    const verboseAuthError = [
      "Error: authentication failed (401 Unauthorized).",
      "The API token you provided is invalid or has expired.",
      "For troubleshooting, see https://example.com/docs/troubleshooting-auth-errors",
      "for step-by-step instructions covering credential configuration, renewal,",
      "and how to verify your account access before retrying the request.",
    ].join("\n");
    // The error text alone is long enough to count as meaningful output, yet
    // a recognized auth failure must stay fallback-eligible.
    expect(hasMeaningfulAgentOutput(verboseAuthError)).toBe(true);
    expect(classifyExitFailure(verboseAuthError, "")).toBe("auth-failed");
  });

  test("auth errors preceded only by startup banners still fall back", () => {
    const bannerThenAuth = [
      "Welcome to Codex",
      "v2.1.0",
      "Session: abc123",
      "error: Invalid API key provided. Check your credentials and retry.",
    ].join("\n");
    expect(hasMeaningfulAgentOutput(bannerThenAuth)).toBe(false);
    expect(classifyExitFailure(bannerThenAuth, "")).toBe("auth-failed");
  });

  test("work transcripts that merely mention auth vocabulary never fall back", () => {
    // Regression: the phrases below match the narrow auth patterns, but they
    // occur after meaningful task content (an implemented login/OAuth flow),
    // so the exit must be classified as post-work rather than auth-failed.
    const transcript =
      "Implemented the OAuth login feature end to end: created src/auth/device-flow.ts " +
      "exposing startDeviceAuthorization() with polling, wired the token exchange into\n" +
      "the session store, and documented that users are told 'You need to log in to the " +
      "API' whenever a stored token is invalid so the UI can prompt for re-authentication.";
    expect(hasMeaningfulAgentOutput(transcript)).toBe(true);
    expect(detectAuthFailure(transcript, "")).toBe(true);
    expect(classifyExitFailure(transcript, "exit status 1")).toBeNull();
  });

  test("an explicit auth error line after real work still classifies as auth-failed", () => {
    const workedThenFailed = [
      "Implemented the OAuth login feature across src/auth/device-flow.ts and its tests,",
      "covering polling timeouts and the credential refresh path.",
      "Error: invalid api key provided.",
    ].join("\n");
    expect(hasMeaningfulAgentOutput(workedThenFailed)).toBe(true);
    expect(classifyExitFailure(workedThenFailed, "")).toBe("auth-failed");
  });
});

describe("AgentLaunchError", () => {
  test("carries its classification and captured output", () => {
    const error = new AgentLaunchError("Agent exited with code 2", {
      classification: "auth-failed",
      stdout: "",
      stderr: "not logged in",
      exitCode: 2,
    });
    expect(error.classification).toBe("auth-failed");
    expect(error.exitCode).toBe(2);
    expect(isFallbackEligible(error.classification)).toBe(true);
  });

  test("factory helpers produce eligible classes", () => {
    expect(executableMissingError("CLI not found").classification).toBe("executable-missing");
    expect(spawnFailedError("Failed to run agent").classification).toBe("spawn-failed");
  });
});

describe("sanitizeFallbackReason", () => {
  test("redacts credential-shaped substrings", () => {
    const sanitized = sanitizeFallbackReason("auth failed for sk-ant-api03-abcdef1234567890");
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).not.toContain("sk-ant");
  });

  test("redacts env-var-style secrets with '=' and ':' separators", () => {
    const sanitized = sanitizeFallbackReason(
      "AUTH_TOKEN=abc123secret and API_KEY=shortvalue1 (token=deadbeef123)",
    );
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).not.toContain("abc123secret");
    expect(sanitized).not.toContain("shortvalue1");
    expect(sanitized).not.toContain("deadbeef123");
  });

  test("collapses newlines and clamps length", () => {
    const long = `line one\n${"x".repeat(500)}`;
    const sanitized = sanitizeFallbackReason(long);
    expect(sanitized).not.toContain("\n");
    expect(sanitized.length).toBeLessThanOrEqual(201);
  });
});
