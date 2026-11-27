import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

/** Binary names `scripts/install.sh` probes to decide whether to print the "install a coding agent" hint. */
function installScriptAgentNames(): string[] {
  const script = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");
  const match = /have_agent_cli\(\) \{\n\s*for agent in ([^;]+);/.exec(script);
  if (!match?.[1]) throw new Error("have_agent_cli loop not found in scripts/install.sh");
  return match[1].trim().split(/\s+/).sort();
}

/** Default CLI binary of every harness in `@devintern/agent-harness`. */
function harnessDefaultPaths(): string[] {
  const dir = join(repoRoot, "packages", "agent-harness", "src", "harnesses");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const m of source.matchAll(/readonly defaultPath = "([^"]+)"/g)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names].sort();
}

describe("scripts/install.sh", () => {
  test("agent CLI probe matches every harness default binary", () => {
    const harnesses = harnessDefaultPaths();
    expect(harnesses.length).toBeGreaterThan(0);
    expect(installScriptAgentNames()).toEqual(harnesses);
  });
});
