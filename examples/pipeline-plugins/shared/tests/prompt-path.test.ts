import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { resolvePromptPath } from "../prompt-path";

describe("resolvePromptPath", () => {
  const workingDir = resolve("/checkout");
  const pipelineDir = resolve("/home/me/.devintern/pipelines");

  test("resolves a relative path against pipelineDir", () => {
    expect(resolvePromptPath("./prompts/review.md", { workingDir, pipelineDir })).toBe(
      join(pipelineDir, "prompts", "review.md"),
    );
  });

  test("falls back to workingDir only when pipelineDir is null or unset", () => {
    expect(resolvePromptPath("./prompts/review.md", { workingDir, pipelineDir: null })).toBe(
      join(workingDir, "prompts", "review.md"),
    );
    expect(resolvePromptPath("prompts/review.md", { workingDir })).toBe(
      join(workingDir, "prompts", "review.md"),
    );
  });

  test("returns an absolute path unchanged", () => {
    const absolute = resolve("/etc/prompts/review.md");
    expect(resolvePromptPath(absolute, { workingDir, pipelineDir })).toBe(absolute);
    expect(resolvePromptPath(absolute, { workingDir, pipelineDir: null })).toBe(absolute);
  });
});
