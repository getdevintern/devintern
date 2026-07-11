import { afterEach, describe, expect, test } from "bun:test";
import type { AgentHarness, AgentRunOptions } from "@devintern/agent-harness";

import {
  ReadonlyAnalysisError,
  analysisRunOptions,
  runAnalysisWithFallback,
  shouldRetryInDefaultMode,
} from "../src/lib/analysis-mode";

const readonlyHarness: AgentHarness = {
  name: "fake-readonly",
  displayName: "Fake Readonly",
  defaultPath: "fake",
  supportedModes: ["readonly"],
  buildArgs: () => [],
};

const defaultOnlyHarness: AgentHarness = {
  name: "fake-default",
  displayName: "Fake Default",
  defaultPath: "fake",
  buildArgs: () => [],
};

afterEach(() => {
  delete process.env.AGENT_ANALYSIS_ALLOWED_TOOLS;
});

describe("analysisRunOptions", () => {
  test("uses readonly mode without permission-skip when supported", () => {
    const options = analysisRunOptions(readonlyHarness, 10);
    expect(options.mode).toBe("readonly");
    expect(options.skipPermissions).toBe(false);
    expect(options.allowedTools).toBeUndefined();
  });

  test("parses AGENT_ANALYSIS_ALLOWED_TOOLS into allowedTools", () => {
    process.env.AGENT_ANALYSIS_ALLOWED_TOOLS = " mcp__notion , mcp__figma__get_design_context ,";
    const options = analysisRunOptions(readonlyHarness, 10);
    expect(options.allowedTools).toEqual(["mcp__notion", "mcp__figma__get_design_context"]);
  });

  test("falls back to unattended defaults without readonly support", () => {
    const options = analysisRunOptions(defaultOnlyHarness, 10);
    expect(options.mode).toBeUndefined();
    expect(options.skipPermissions).toBe(true);
  });
});

describe("shouldRetryInDefaultMode", () => {
  test("retries on ReadonlyAnalysisError and generic exit errors", () => {
    expect(shouldRetryInDefaultMode(new ReadonlyAnalysisError("empty stdout"))).toBe(true);
    expect(shouldRetryInDefaultMode(new Error("Agent clarity check exited with code 2"))).toBe(
      true,
    );
  });

  test("never retries timeouts, missing CLIs, or usage limits", () => {
    expect(shouldRetryInDefaultMode(new Error("Agent timed out after 60 minutes"))).toBe(false);
    expect(shouldRetryInDefaultMode(new Error("Claude Code CLI not found at: claude"))).toBe(false);
    const usageLimit = new Error("Agent usage limit reached");
    usageLimit.name = "UsageLimitError";
    expect(shouldRetryInDefaultMode(usageLimit)).toBe(false);
  });
});

describe("runAnalysisWithFallback", () => {
  test("retries once in default mode when the readonly run fails retriably", async () => {
    const attempts: AgentRunOptions[] = [];
    const result = await runAnalysisWithFallback(readonlyHarness, 10, async (options) => {
      attempts.push(options);
      if (options.mode === "readonly") {
        throw new ReadonlyAnalysisError("empty stdout");
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.mode).toBe("readonly");
    expect(attempts[1]?.mode).toBeUndefined();
    expect(attempts[1]?.skipPermissions).toBe(true);
  });

  test("does not retry non-retriable failures", async () => {
    let attempts = 0;
    await expect(
      runAnalysisWithFallback(readonlyHarness, 10, async () => {
        attempts++;
        throw new Error("Agent timed out after 60 minutes");
      }),
    ).rejects.toThrow(/timed out/);
    expect(attempts).toBe(1);
  });

  test("runs exactly once for harnesses without readonly support", async () => {
    let attempts = 0;
    await expect(
      runAnalysisWithFallback(defaultOnlyHarness, 10, async () => {
        attempts++;
        throw new Error("some failure");
      }),
    ).rejects.toThrow("some failure");
    expect(attempts).toBe(1);
  });

  test("returns the first result when the readonly run succeeds", async () => {
    let attempts = 0;
    const result = await runAnalysisWithFallback(readonlyHarness, 10, async () => {
      attempts++;
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(1);
  });
});
