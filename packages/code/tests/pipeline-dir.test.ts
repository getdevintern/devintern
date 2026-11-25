import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkspacePipelinePath } from "../src/lib/workspace/config";
import type { RepoConfig } from "../src/lib/workspace/config";
import {
  WORKSPACE_PIPELINE_DEFAULT_ENV,
  WORKSPACE_PIPELINE_REPO_ENV,
  buildRepoEnv,
} from "../src/lib/workspace/env";
import { pipelineDirFor, selectPipelineConfig } from "../src/lib/task/pipeline-selection";
import { runTaskSteps } from "../src/lib/task/step-runner";
import type { TaskStep } from "../src/lib/task/step-runner";

let root: string;
let workspaceDir: string;
let repoDir: string;

function writePipeline(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ steps: [{ use: "implement" }, { use: "finalize" }] }));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pipeline-dir-"));
  workspaceDir = join(root, "workspace");
  repoDir = join(root, "repo");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pipelineDirFor", () => {
  test("is the workspace default file's directory", () => {
    const file = writePipeline(join(workspaceDir, "pipelines"), "default.json");
    const selection = selectPipelineConfig({
      cwd: repoDir,
      env: { [WORKSPACE_PIPELINE_DEFAULT_ENV]: file },
    });
    expect(selection.scope).toBe("workspace-default");
    expect(pipelineDirFor(selection)).toBe(join(workspaceDir, "pipelines"));
  });

  test("is the per-repo file's directory, not the default's", () => {
    const defaultFile = writePipeline(join(workspaceDir, "pipelines"), "default.json");
    const repoFile = writePipeline(join(workspaceDir, "pipelines", "backend"), "backend.json");
    const selection = selectPipelineConfig({
      cwd: repoDir,
      env: {
        [WORKSPACE_PIPELINE_REPO_ENV]: repoFile,
        [WORKSPACE_PIPELINE_DEFAULT_ENV]: defaultFile,
      },
    });
    expect(selection.scope).toBe("workspace-repo");
    expect(pipelineDirFor(selection)).toBe(join(workspaceDir, "pipelines", "backend"));
  });

  test("is null for the built-in default even though baseDir is the checkout", () => {
    const selection = selectPipelineConfig({ cwd: repoDir, env: {} });
    expect(selection.scope).toBe("built-in");
    expect(selection.baseDir).toBe(repoDir);
    expect(pipelineDirFor(selection)).toBeNull();
  });

  test("is absolute even for a relative source path", () => {
    expect(
      pipelineDirFor({ scope: "workspace-default", sourcePath: "pipelines/x.json", baseDir: "." }),
    ).toBe(join(process.cwd(), "pipelines"));
  });
});

describe("workspace pipeline_file references", () => {
  test("expands a leading ~/ to the home directory", () => {
    const repo: RepoConfig = {
      name: "app",
      remote: "git@github.com:acme/app.git",
      env: {},
      pipelineFile: "~/.devintern/pipelines/app.json",
    };
    expect(buildRepoEnv(repo, workspaceDir)[WORKSPACE_PIPELINE_REPO_ENV]).toBe(
      join(homedir(), ".devintern", "pipelines", "app.json"),
    );
    expect(resolveWorkspacePipelinePath(workspaceDir, "~/.devintern/pipelines/default.json")).toBe(
      join(homedir(), ".devintern", "pipelines", "default.json"),
    );
    expect(
      pipelineDirFor({
        scope: "workspace-default",
        sourcePath: resolveWorkspacePipelinePath(
          workspaceDir,
          "~/.devintern/pipelines/default.json",
        ),
        baseDir: workspaceDir,
      }),
    ).toBe(join(homedir(), ".devintern", "pipelines"));
  });

  test("keeps workspace-relative and absolute references", () => {
    expect(resolveWorkspacePipelinePath(workspaceDir, "pipelines/a.json")).toBe(
      join(workspaceDir, "pipelines", "a.json"),
    );
    expect(resolveWorkspacePipelinePath(workspaceDir, "/abs/a.json")).toBe("/abs/a.json");
  });

  test("gives concurrent tasks for different repos their own pipelineDir", () => {
    const frontendFile = writePipeline(join(workspaceDir, "pipelines", "frontend"), "p.json");
    const backendFile = writePipeline(join(workspaceDir, "pipelines", "backend"), "p.json");
    const frontend: RepoConfig = {
      name: "frontend",
      remote: "git@github.com:acme/frontend.git",
      env: {},
      pipelineFile: "pipelines/frontend/p.json",
    };
    const backend: RepoConfig = {
      name: "backend",
      remote: "git@github.com:acme/backend.git",
      env: {},
      pipelineFile: backendFile,
    };
    const frontendEnv = buildRepoEnv(frontend, workspaceDir);
    const backendEnv = buildRepoEnv(backend, workspaceDir);
    expect(frontendEnv[WORKSPACE_PIPELINE_REPO_ENV]).toBe(frontendFile);
    expect(backendEnv[WORKSPACE_PIPELINE_REPO_ENV]).toBe(backendFile);

    const frontendDir = pipelineDirFor(selectPipelineConfig({ cwd: repoDir, env: frontendEnv }));
    const backendDir = pipelineDirFor(selectPipelineConfig({ cwd: repoDir, env: backendEnv }));
    expect(frontendDir).toBe(join(workspaceDir, "pipelines", "frontend"));
    expect(backendDir).toBe(join(workspaceDir, "pipelines", "backend"));
  });
});

describe("pipelineDir across repeated steps", () => {
  test("a repeat sees the same pipelineDir as the first run", async () => {
    const context = { pipelineDir: "/pipelines" as string | null, seen: [] as (string | null)[] };
    let runs = 0;
    const steps: TaskStep<typeof context>[] = [
      { name: "implement", run: async (ctx) => void ctx.seen.push(ctx.pipelineDir) },
      {
        name: "review",
        run: async (ctx) => {
          ctx.seen.push(ctx.pipelineDir);
          return ++runs === 1 ? { kind: "repeat", from: "implement", maxRepeats: 1 } : undefined;
        },
      },
    ];
    const result = await runTaskSteps(steps, context);
    expect(result.kind).toBe("completed");
    expect(context.seen).toEqual(["/pipelines", "/pipelines", "/pipelines", "/pipelines"]);
  });
});
