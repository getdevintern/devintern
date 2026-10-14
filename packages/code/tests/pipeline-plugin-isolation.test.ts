import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plugin definitions live in a process-global registry. Each routed task runs
 * in its own CLI subprocess, so one task's plugins must never be visible to
 * another. These tests spawn two independent Bun processes to pin that the
 * registry does not cross the task boundary.
 */
const SRC = join(import.meta.dir, "..", "src", "lib", "task");
const PIPELINE_CONFIG = join(SRC, "pipeline-config.ts");
const PIPELINE_REGISTRY = join(SRC, "pipeline-registry.ts");

function runScript(script: string, dir: string): { stdout: string; stderr: string; code: number } {
  const path = join(dir, "task.ts");
  writeFileSync(path, script);
  const result = spawnSync("bun", [path], { encoding: "utf8", cwd: dir, timeout: 20000 });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
}

describe("pipeline plugin registry isolation", () => {
  test("a plugin registered in one task subprocess is absent from another", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-isolation-"));
    try {
      const pluginPath = join(dir, "plugin.ts");
      writeFileSync(
        pluginPath,
        `export default { name: "isolation-step", create: () => ({ name: "isolation-step", run: async () => {} }) };\n`,
      );

      const first = runScript(
        `import { resolvePipelineSteps } from ${JSON.stringify(PIPELINE_CONFIG)};
         const steps = await resolvePipelineSteps({ plugins: [${JSON.stringify(pluginPath)}], steps: [
           { use: "implement" }, { use: "commit" }, { use: "isolation-step" }, { use: "finalize" }
         ] }, ${JSON.stringify(dir)});
         console.log("resolved:" + steps.map((step) => step.use).join(","));`,
        dir,
      );
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("resolved:commit,plugin,finalize");

      const second = runScript(
        `import { getStep } from ${JSON.stringify(PIPELINE_REGISTRY)};
         console.log(getStep("isolation-step") ? "leaked" : "isolated");`,
        dir,
      );
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("isolated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
