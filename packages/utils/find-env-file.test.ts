import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigDir, findEnvFile, findProjectRoot } from "./src/find-env-file.ts";

describe("findEnvFile", () => {
  let tempRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "find-env-file-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("finds plain .env in start directory", () => {
    const envPath = join(tempRoot, ".env");
    writeFileSync(envPath, "KEY=value\n");

    const result = findEnvFile({ startDir: tempRoot });
    expect(result).toBe(envPath);
  });

  test("finds config dir .env in start directory", () => {
    const configDir = join(tempRoot, ".devintern-test");
    mkdirSync(configDir, { recursive: true });
    const envPath = join(configDir, ".env");
    writeFileSync(envPath, "KEY=value\n");

    const result = findEnvFile({ startDir: tempRoot, configDirName: ".devintern-test" });
    expect(result).toBe(envPath);
  });

  test("prefers config dir .env over plain .env in same directory", () => {
    const configDir = join(tempRoot, ".devintern-test");
    mkdirSync(configDir, { recursive: true });
    const configEnvPath = join(configDir, ".env");
    const plainEnvPath = join(tempRoot, ".env");
    writeFileSync(configEnvPath, "KEY=config\n");
    writeFileSync(plainEnvPath, "KEY=plain\n");

    const result = findEnvFile({ startDir: tempRoot, configDirName: ".devintern-test" });
    expect(result).toBe(configEnvPath);
  });

  test("finds .env in parent directory", () => {
    const childDir = join(tempRoot, "src", "components");
    mkdirSync(childDir, { recursive: true });
    const envPath = join(tempRoot, ".env");
    writeFileSync(envPath, "KEY=value\n");

    const result = findEnvFile({ startDir: childDir });
    expect(result).toBe(envPath);
  });

  test("finds config dir .env in parent directory", () => {
    const childDir = join(tempRoot, "packages", "web");
    mkdirSync(childDir, { recursive: true });
    const configDir = join(tempRoot, ".devintern-test");
    mkdirSync(configDir, { recursive: true });
    const envPath = join(configDir, ".env");
    writeFileSync(envPath, "KEY=value\n");

    const result = findEnvFile({ startDir: childDir, configDirName: ".devintern-test" });
    expect(result).toBe(envPath);
  });

  test("prefers nearest .env over parent .env", () => {
    const childDir = join(tempRoot, "src");
    mkdirSync(childDir, { recursive: true });
    const childEnvPath = join(childDir, ".env");
    const parentEnvPath = join(tempRoot, ".env");
    writeFileSync(childEnvPath, "KEY=child\n");
    writeFileSync(parentEnvPath, "KEY=parent\n");

    const result = findEnvFile({ startDir: childDir });
    expect(result).toBe(childEnvPath);
  });

  test("stops at .git root when stopAtGitRoot is true", () => {
    const projectDir = join(tempRoot, "project");
    const childDir = join(projectDir, "src");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeFileSync(join(tempRoot, ".env"), "KEY=root\n");

    const result = findEnvFile({ startDir: childDir, stopAtGitRoot: true });
    expect(result).toBeNull();
  });

  test("does not stop at .git root when stopAtGitRoot is false", () => {
    const projectDir = join(tempRoot, "project");
    const childDir = join(projectDir, "src");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    const rootEnvPath = join(tempRoot, ".env");
    writeFileSync(rootEnvPath, "KEY=root\n");

    const result = findEnvFile({ startDir: childDir, stopAtGitRoot: false });
    expect(result).toBe(rootEnvPath);
  });

  test("returns null when no .env is found", () => {
    const result = findEnvFile({ startDir: tempRoot });
    expect(result).toBeNull();
  });

  test("returns null when no .env is found in deeply nested directory", () => {
    const deepDir = join(tempRoot, "a", "b", "c", "d");
    mkdirSync(deepDir, { recursive: true });

    const result = findEnvFile({ startDir: deepDir });
    expect(result).toBeNull();
  });

  test("finds .env at filesystem boundary without error", () => {
    const result = findEnvFile({ startDir: tempRoot });
    expect(result).toBeNull();
  });
});

describe("findConfigDir", () => {
  let tempRoot: string;
  let originalGitCeilings: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "find-config-dir-"));
    originalGitCeilings = process.env.GIT_CEILING_DIRECTORIES;
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
  });

  afterEach(() => {
    if (originalGitCeilings === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = originalGitCeilings;
    process.env.HOME = originalHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("finds config dir in start directory", () => {
    const configDir = join(tempRoot, ".devintern-test");
    mkdirSync(configDir, { recursive: true });

    const result = findConfigDir({ startDir: tempRoot, configDirName: ".devintern-test" });
    expect(result).toBe(configDir);
  });

  test("finds config dir in parent directory", () => {
    const childDir = join(tempRoot, "packages", "web");
    mkdirSync(childDir, { recursive: true });
    const configDir = join(tempRoot, ".devintern-test");
    mkdirSync(configDir, { recursive: true });

    const result = findConfigDir({ startDir: childDir, configDirName: ".devintern-test" });
    expect(result).toBe(configDir);
  });

  test("prefers nearest config dir over parent config dir", () => {
    const childDir = join(tempRoot, "packages");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(tempRoot, ".devintern-test"), { recursive: true });
    const childConfigDir = join(childDir, ".devintern-test");
    mkdirSync(childConfigDir, { recursive: true });

    const result = findConfigDir({ startDir: childDir, configDirName: ".devintern-test" });
    expect(result).toBe(childConfigDir);
  });

  test("stops at .git root when stopAtGitRoot is true", () => {
    const projectDir = join(tempRoot, "project");
    const childDir = join(projectDir, "src");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(tempRoot, ".devintern-test"), { recursive: true });

    const result = findConfigDir({
      startDir: childDir,
      configDirName: ".devintern-test",
      stopAtGitRoot: true,
    });
    expect(result).toBeNull();
  });

  test("returns null when config dir is not found", () => {
    const result = findConfigDir({ startDir: tempRoot, configDirName: ".devintern-test" });
    expect(result).toBeNull();
  });

  test("does not inspect a config directory at a Git ceiling", () => {
    const ceilingDir = join(tempRoot, "ceiling");
    const childDir = join(ceilingDir, "fixture");
    mkdirSync(join(ceilingDir, ".devintern-test"), { recursive: true });
    mkdirSync(childDir, { recursive: true });
    process.env.GIT_CEILING_DIRECTORIES = ceilingDir;

    const result = findConfigDir({ startDir: childDir, configDirName: ".devintern-test" });
    expect(result).toBeNull();
  });
});

describe("findProjectRoot", () => {
  let tempRoot: string;
  let originalGitCeilings: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "find-project-root-"));
    originalGitCeilings = process.env.GIT_CEILING_DIRECTORIES;
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
  });

  afterEach(() => {
    if (originalGitCeilings === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = originalGitCeilings;
    process.env.HOME = originalHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("finds the nearest .git directory walking up from a subdirectory", () => {
    const projectDir = join(tempRoot, "project");
    const childDir = join(projectDir, "packages", "app");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });

    const result = findProjectRoot({ startDir: childDir });
    expect(result).toBe(projectDir);
  });

  test("treats a .git file (worktree/submodule) as a repo root", () => {
    const projectDir = join(tempRoot, "project");
    const childDir = join(projectDir, "src");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(projectDir, ".git"), "gitdir: elsewhere\n");

    const result = findProjectRoot({ startDir: childDir });
    expect(result).toBe(projectDir);
  });

  test("falls back to the start directory outside a repository", () => {
    const result = findProjectRoot({ startDir: tempRoot });
    expect(result).toBe(tempRoot);
  });

  test("ignores an ambient .git marker at a Git ceiling", () => {
    const ceilingDir = join(tempRoot, "ceiling");
    const childDir = join(ceilingDir, "fixture");
    mkdirSync(join(ceilingDir, ".git"), { recursive: true });
    mkdirSync(childDir, { recursive: true });
    process.env.GIT_CEILING_DIRECTORIES = ceilingDir;

    const result = findProjectRoot({ startDir: childDir });
    expect(result).toBe(childDir);
  });
});
