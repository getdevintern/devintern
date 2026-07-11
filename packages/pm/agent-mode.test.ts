import { describe, expect, test } from "bun:test";
import { getHarness, type AgentHarness } from "@devintern/agent-harness";

import { withReadonlyMode } from "./lib/agent";

function requireHarness(name: string) {
  const harness = getHarness(name);
  if (!harness) {
    throw new Error(`Unknown harness: ${name}`);
  }
  return harness;
}

/** Hypothetical harness whose readonly mode keeps network/MCP tools usable. */
const externalToolsFriendlyHarness: AgentHarness = {
  name: "fake",
  displayName: "Fake",
  defaultPath: "fake",
  supportedModes: ["readonly"],
  constrainedModeAllowsExternalTools: true,
  buildArgs: () => [],
};

describe("withReadonlyMode", () => {
  test("uses native readonly mode when it keeps external tools usable", () => {
    const options = withReadonlyMode(externalToolsFriendlyHarness, {
      maxTurns: 100,
      skipPermissions: true,
    });
    expect(options.mode).toBe("readonly");
    expect(options.skipPermissions).toBe(false);
    expect(options.maxTurns).toBe(100);
  });

  test("skips readonly when the mode would restrict network/MCP tools", () => {
    // Claude Code supports readonly (plan permission mode), but that mode
    // denies non-annotated MCP tools — devpm generation may need them.
    const harness = requireHarness("claude-code");
    const options = withReadonlyMode(harness, { maxTurns: 100, skipPermissions: true });
    expect(options.mode).toBeUndefined();
    expect(options.skipPermissions).toBe(true);
  });

  test("keeps unattended defaults for harnesses without native support", () => {
    const harness = requireHarness("cline");
    const options = withReadonlyMode(harness, { maxTurns: 100, skipPermissions: true });
    expect(options.mode).toBeUndefined();
    expect(options.skipPermissions).toBe(true);
  });

  test("no registered harness currently declares external-tool-safe readonly", () => {
    // If a harness CLI grows a "read-only files, full network" mode, set
    // constrainedModeAllowsExternalTools on it and update this expectation.
    for (const name of ["claude-code", "codex", "cursor", "gemini", "grok", "opencode"]) {
      expect(requireHarness(name).constrainedModeAllowsExternalTools).not.toBe(true);
    }
  });
});
