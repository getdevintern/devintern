import { afterEach, describe, expect, test } from "bun:test";
import type { AgentHarness, AgentRunOptions } from "@devintern/agent-harness";

import {
  PREFER_READONLY_ANALYSIS,
  ReadonlyAnalysisError,
  analysisRunOptions,
  defaultAnalysisRunOptions,
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
  delete process.env.AGENT_MODEL;
});

describe("analysisRunOptions", () => {
  test("uses unattended defaults while PREFER_READONLY_ANALYSIS is off", () => {
    expect(PREFER_READONLY_ANALYSIS).toBe(false);
    const options = analysisRunOptions(readonlyHarness, 10);
    expect(options.mode).toBeUndefined();
    expect(options.skipPermissions).toBe(true);
    expect(options.allowedTools).toBeUndefined();
  });

  test("ignores AGENT_ANALYSIS_ALLOWED_TOOLS while readonly is disabled", () => {
    process.env.AGENT_ANALYSIS_ALLOWED_TOOLS = " mcp__notion , mcp__figma__get_design_context ,";
    const options = analysisRunOptions(readonlyHarness, 10);
    expect(options.allowedTools).toBeUndefined();
  });

  test("falls back to unattended defaults without readonly support", () => {
    const options = analysisRunOptions(defaultOnlyHarness, 10);
    expect(options.mode).toBeUndefined();
    expect(options.skipPermissions).toBe(true);
  });

  test("includes AGENT_MODEL in unattended options when set", () => {
    process.env.AGENT_MODEL = "sonnet";
    const options = defaultAnalysisRunOptions(10);
    expect(options.model).toBe("sonnet");
  });

  test("omits model when AGENT_MODEL is unset", () => {
    const options = defaultAnalysisRunOptions(10);
    expect(options.model).toBeUndefined();
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
  test("runs once in default mode while readonly preference is off", async () => {
    const attempts: AgentRunOptions[] = [];
    const result = await runAnalysisWithFallback(readonlyHarness, 10, async (options) => {
      attempts.push(options);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.mode).toBeUndefined();
    expect(attempts[0]?.skipPermissions).toBe(true);
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
});
