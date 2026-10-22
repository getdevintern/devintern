import { describe, expect, test } from "bun:test";
import {
  ClaudeCodeHarness,
  CodexHarness,
  DeepSeekHarness,
  GrokHarness,
  KimiHarness,
  OpencodeHarness,
} from "@devintern/agent-harness";
import { buildHeadlessAgentInvocation, HEADLESS_AGENT_STDIO } from "../src/lib/agent/spawn";

const runOptions = { skipPermissions: true, workingDir: "/tmp/repo" };
// A path that does not exist keeps the Opencode version probe offline (ENOENT),
// so the harness resolves to its v1 baseline without spawning a real CLI.
const noCli = "/nonexistent/opencode";

describe("buildHeadlessAgentInvocation", () => {
  test("grok receives -p so it does not open the TUI", async () => {
    const { args } = await buildHeadlessAgentInvocation(
      new GrokHarness(),
      "grok",
      "fix the hook",
      runOptions,
    );
    expect(args).toContain("-p");
    expect(args).toContain("fix the hook");
    expect(args.indexOf("-p")).toBeLessThan(args.indexOf("fix the hook"));
  });

  test("kimi receives --prompt so it does not open the TUI", async () => {
    const { args } = await buildHeadlessAgentInvocation(
      new KimiHarness(),
      "kimi",
      "review this",
      runOptions,
    );
    expect(args).toContain("--prompt");
    expect(args).toContain("review this");
  });

  test("claude-code receives -p", async () => {
    const { args } = await buildHeadlessAgentInvocation(
      new ClaudeCodeHarness(),
      "claude",
      "implement it",
      runOptions,
    );
    expect(args).toContain("-p");
    expect(args).toContain("implement it");
  });

  test("opencode and codex receive the prompt as a positional argument", async () => {
    expect(
      (await buildHeadlessAgentInvocation(new OpencodeHarness(), noCli, "do the task", runOptions))
        .args,
    ).toContain("do the task");
    expect(
      (await buildHeadlessAgentInvocation(new CodexHarness(), "codex", "do the task", runOptions))
        .args,
    ).toContain("do the task");
  });

  test("dash-leading prompts get an end-of-options marker so they are not parsed as flags", async () => {
    const frontmatter = "---\ntype: Task\n---\nCheck merged PRs and write tweets";
    const { args } = await buildHeadlessAgentInvocation(
      new OpencodeHarness(),
      noCli,
      frontmatter,
      runOptions,
    );
    expect(args.slice(-2)).toEqual(["--", frontmatter]);
  });

  test("official DeepSeek Harness warns that AGENT_EFFORT is ignored on the Code path", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      const { args } = await buildHeadlessAgentInvocation(
        new DeepSeekHarness(),
        "/nonexistent/dsh",
        "implement it",
        { ...runOptions, effort: "high", maxTurns: 500 },
      );
      expect(args).toEqual(["headless", "implement it"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("does not support reasoning effort");
    expect(warnings[0]).toContain('ignoring effort "high"');
    expect(warnings[0]).toContain("$DSH_HOME/profiles/headless/cordis.patch.yml");
  });

  test("headless stdio ignores stdin so TUI CLIs cannot attach a TTY", () => {
    expect(HEADLESS_AGENT_STDIO).toEqual(["ignore", "pipe", "pipe"]);
  });
});
