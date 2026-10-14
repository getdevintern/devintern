import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  WORKSPACE_PIPELINE_DEFAULT_ENV,
  WORKSPACE_PIPELINE_REPO_ENV,
} from "../src/lib/workspace/env";
import { resolvePipelineSteps } from "../src/lib/task/pipeline-config";
import {
  describePipelineSelection,
  loadPipelineConfigFile,
  resolveWorkspaceRelativePaths,
  selectPipelineConfig,
} from "../src/lib/task/pipeline-selection";

let root: string;
let workspaceDir: string;
let repoDir: string;

function writePipeline(dir: string, name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pipeline-selection-"));
  workspaceDir = join(root, "workspace");
  repoDir = join(root, "repo");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("selectPipelineConfig precedence", () => {
  test("falls back to the built-in default with no references", () => {
    const selection = selectPipelineConfig({ settings: null, cwd: repoDir, env: {} });
    expect(selection.scope).toBe("built-in");
    expect(selection.config).toBeUndefined();
    expect(selection.sourcePath).toBeNull();
    expect(selection.baseDir).toBe(repoDir);
  });

  test("uses the workspace default when the repository has no pipeline", () => {
    const file = writePipeline(workspaceDir, "default.json", {
      steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: {},
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_DEFAULT_ENV]: file },
    });
    expect(selection.scope).toBe("workspace-default");
    expect(selection.sourcePath).toBe(file);
    expect(selection.baseDir).toBe(workspaceDir);
    expect(selection.config?.steps?.map((step) => step.use)).toEqual([
      "implement",
      "commit",
      "finalize",
    ]);
  });

  test("repository settings.json wins over the workspace default", () => {
    const file = writePipeline(workspaceDir, "default.json", {
      steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: {
        pipeline: { steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }] },
      },
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_DEFAULT_ENV]: file },
    });
    expect(selection.scope).toBe("repository");
    expect(selection.sourcePath).toBe(join(repoDir, ".devintern-code", "settings.json"));
    expect(selection.baseDir).toBe(repoDir);
  });

  test("workspace per-repository override wins over repository settings", () => {
    const file = writePipeline(workspaceDir, "backend.json", {
      steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: { pipeline: { steps: [{ use: "clarity" }, { use: "implement" }] } },
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_REPO_ENV]: file, [WORKSPACE_PIPELINE_DEFAULT_ENV]: "/def.json" },
    });
    expect(selection.scope).toBe("workspace-repo");
    expect(selection.sourcePath).toBe(file);
    expect(selection.baseDir).toBe(workspaceDir);
  });

  test("does not merge steps across scopes", () => {
    const file = writePipeline(workspaceDir, "backend.json", {
      steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: { pipeline: { steps: [{ use: "clarity" }] } },
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_REPO_ENV]: file },
    });
    expect(selection.config?.steps).toHaveLength(3);
  });

  test("re-reads the referenced file so edits apply to subsequent runs", () => {
    const file = join(workspaceDir, "reload.json");
    writeFileSync(
      file,
      JSON.stringify({ steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }] }),
    );
    const env = { [WORKSPACE_PIPELINE_REPO_ENV]: file };
    const first = selectPipelineConfig({ settings: null, cwd: repoDir, env });
    writeFileSync(
      file,
      JSON.stringify({
        steps: [
          { use: "implement" },
          { use: "commit" },
          { use: "auto-review" },
          { use: "finalize" },
        ],
      }),
    );
    const second = selectPipelineConfig({ settings: null, cwd: repoDir, env });
    expect(first.config?.steps?.map((step) => step.use)).toEqual([
      "implement",
      "commit",
      "finalize",
    ]);
    expect(second.config?.steps?.map((step) => step.use)).toEqual([
      "implement",
      "commit",
      "auto-review",
      "finalize",
    ]);
  });
});

describe("loadPipelineConfigFile", () => {
  test("reports a missing file with its path", () => {
    const missing = join(workspaceDir, "nope.json");
    expect(() => loadPipelineConfigFile(missing)).toThrow(/Cannot read pipeline file/);
    expect(() => loadPipelineConfigFile(missing)).toThrow(missing);
  });

  test("reports invalid JSON with its path", () => {
    const path = join(workspaceDir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => loadPipelineConfigFile(path)).toThrow(/Invalid JSON in pipeline file/);
    expect(() => loadPipelineConfigFile(path)).toThrow(path);
  });

  test("rejects a non-object document", () => {
    const path = join(workspaceDir, "array.json");
    writeFileSync(path, "[]");
    expect(() => loadPipelineConfigFile(path)).toThrow(/must contain a JSON object/);
  });

  test("rejects a non-array steps field", () => {
    const path = writePipeline(workspaceDir, "bad.json", { steps: {} });
    expect(() => loadPipelineConfigFile(path)).toThrow(/"steps" must be an array/);
  });

  test("a missing selected file fails selection instead of falling back", () => {
    expect(() =>
      selectPipelineConfig({
        settings: null,
        cwd: repoDir,
        env: { [WORKSPACE_PIPELINE_REPO_ENV]: join(workspaceDir, "missing.json") },
      }),
    ).toThrow(/Cannot read pipeline file/);
  });
});

describe("resolveWorkspaceRelativePaths", () => {
  test("resolves relative plugin paths against the declaring directory", () => {
    const config = resolveWorkspaceRelativePaths(
      { plugins: ["./steps/check.ts", "some-package"], steps: [] },
      workspaceDir,
    );
    expect(config.plugins).toEqual([join(workspaceDir, "steps/check.ts"), "some-package"]);
  });

  test("resolves an existing relative verify prompt next to the config file", () => {
    mkdirSync(join(workspaceDir, "prompts"), { recursive: true });
    writeFileSync(join(workspaceDir, "prompts/verify.md"), "Check it");
    const config = resolveWorkspaceRelativePaths(
      { steps: [{ use: "verify", prompt: "./prompts/verify.md" }] },
      workspaceDir,
    );
    expect(config.steps?.[0]?.prompt).toBe(join(workspaceDir, "prompts/verify.md"));
  });

  test("keeps inline verify instructions untouched", () => {
    const config = resolveWorkspaceRelativePaths(
      { steps: [{ use: "verify", prompt: "Verify the login flow" }] },
      workspaceDir,
    );
    expect(config.steps?.[0]?.prompt).toBe("Verify the login flow");
  });

  test("keeps repository-relative resolution for a repository settings config", () => {
    const selection = selectPipelineConfig({
      settings: { pipeline: { plugins: ["./local-step.ts"] } },
      cwd: repoDir,
      env: {},
    });
    expect(selection.config?.plugins).toEqual(["./local-step.ts"]);
  });
});

describe("describePipelineSelection", () => {
  test("names the scope, source, and step sequence for workspace files", () => {
    const file = writePipeline(workspaceDir, "backend.json", {
      steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: null,
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_REPO_ENV]: file },
    });
    expect(describePipelineSelection(selection, selection.config)).toBe(
      `workspace-repo (${file}): implement → commit → finalize`,
    );
  });

  test("labels the built-in default", () => {
    const selection = selectPipelineConfig({ settings: null, cwd: repoDir, env: {} });
    expect(describePipelineSelection(selection, undefined)).toBe(
      "built-in default: implement → commit → auto-review → finalize",
    );
  });
});

describe("workspace pipeline plugin resolution", () => {
  test("resolves a relative plugin from the declaring configuration directory", async () => {
    const stepName = `relstep${randomUUID().replace(/-/g, "")}`;
    writeFileSync(
      join(workspaceDir, "step.ts"),
      `export default { name: ${JSON.stringify(stepName)}, create: () => ({ name: ${JSON.stringify(stepName)}, run: async () => {} }) };\n`,
    );
    const file = writePipeline(workspaceDir, "rel.json", {
      plugins: ["./step.ts"],
      steps: [{ use: "implement" }, { use: "commit" }, { use: stepName }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: null,
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_REPO_ENV]: file },
    });
    const steps = await resolvePipelineSteps(selection.config, selection.baseDir);
    expect(steps.map((step) => step.use)).toEqual(["commit", "plugin", "finalize"]);
  });

  test("resolves package plugins from the declaring configuration directory", async () => {
    const packageName = `pkgstep${randomUUID().replace(/-/g, "")}`;
    const packageDir = join(workspaceDir, "node_modules", packageName);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: packageName, main: "index.ts" }),
    );
    writeFileSync(
      join(packageDir, "index.ts"),
      `export default { name: ${JSON.stringify(packageName)}, create: () => ({ name: ${JSON.stringify(packageName)}, run: async () => {} }) };\n`,
    );

    const file = writePipeline(workspaceDir, "pkg.json", {
      plugins: [packageName],
      steps: [{ use: "implement" }, { use: "commit" }, { use: packageName }, { use: "finalize" }],
    });
    const selection = selectPipelineConfig({
      settings: null,
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_REPO_ENV]: file },
    });
    const steps = await resolvePipelineSteps(selection.config, selection.baseDir);
    expect(steps.map((step) => step.use)).toEqual(["commit", "plugin", "finalize"]);
  });
});
