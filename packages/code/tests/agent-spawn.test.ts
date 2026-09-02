import { describe, expect, test } from "bun:test";
import {
  ClaudeCodeHarness,
  CodexHarness,
  GrokHarness,
  KimiHarness,
  OpencodeHarness,
} from "@devintern/agent-harness";
import { buildHeadlessAgentArgs, HEADLESS_AGENT_STDIO } from "../src/lib/agent-spawn";

const runOptions = { skipPermissions: true, workingDir: "/tmp/repo" };

describe("buildHeadlessAgentArgs", () => {
  test("grok receives -p so it does not open the TUI", () => {
    const args = buildHeadlessAgentArgs(new GrokHarness(), "fix the hook", runOptions);
    expect(args).toContain("-p");
    expect(args).toContain("fix the hook");
    expect(args.indexOf("-p")).toBeLessThan(args.indexOf("fix the hook"));
  });

  test("kimi receives --prompt so it does not open the TUI", () => {
    const args = buildHeadlessAgentArgs(new KimiHarness(), "review this", runOptions);
    expect(args).toContain("--prompt");
    expect(args).toContain("review this");
  });

  test("claude-code receives -p", () => {
    const args = buildHeadlessAgentArgs(new ClaudeCodeHarness(), "implement it", runOptions);
    expect(args).toContain("-p");
    expect(args).toContain("implement it");
  });

  test("opencode and codex receive the prompt as a positional argument", () => {
    expect(buildHeadlessAgentArgs(new OpencodeHarness(), "do the task", runOptions)).toContain(
      "do the task",
    );
    expect(buildHeadlessAgentArgs(new CodexHarness(), "do the task", runOptions)).toContain(
      "do the task",
    );
  });

  test("dash-leading prompts get an end-of-options marker so they are not parsed as flags", () => {
    const frontmatter = "---\ntype: Task\n---\nCheck merged PRs and write tweets";
    const args = buildHeadlessAgentArgs(new OpencodeHarness(), frontmatter, runOptions);
    expect(args.slice(-2)).toEqual(["--", frontmatter]);
  });

  test("headless stdio ignores stdin so TUI CLIs cannot attach a TTY", () => {
    expect(HEADLESS_AGENT_STDIO).toEqual(["ignore", "pipe", "pipe"]);
  });
});
