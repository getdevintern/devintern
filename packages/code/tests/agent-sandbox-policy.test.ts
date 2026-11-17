import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { agentSandboxPolicy, workspaceAgentWritablePaths } from "../src/lib/agent/sandbox";

describe("workspaceAgentWritablePaths", () => {
  test("grants the workspace directories agent-facing features write to", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-sandbox-policy-"));
    try {
      for (const name of ["injected", "state", "automations"]) {
        mkdirSync(join(dir, name));
      }
      expect(workspaceAgentWritablePaths(dir)).toEqual([
        join(dir, "injected"),
        join(dir, "state"),
        join(dir, "automations"),
      ]);
      expect(agentSandboxPolicy(dir)).toEqual({ writablePaths: workspaceAgentWritablePaths(dir) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves the default policy untouched when the workspace does not exist", () => {
    const dir = join(tmpdir(), `missing-workspace-${Date.now()}`);
    expect(workspaceAgentWritablePaths(dir)).toEqual([]);
    expect(agentSandboxPolicy(dir)).toEqual({ writablePaths: [] });
  });
});
