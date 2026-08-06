import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCodeConfig } from "./session.ts";

describe("detectCodeConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns false when .devintern-code is absent", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    expect(await detectCodeConfig(tempDir)).toBe(false);
  });

  test("returns true when .devintern-code exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    await mkdir(join(tempDir, ".devintern-code"));
    expect(await detectCodeConfig(tempDir)).toBe(true);
  });

  test("returns true when .devintern-code is in a parent directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    await mkdir(join(tempDir, ".devintern-code"));
    const nested = join(tempDir, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(await detectCodeConfig(nested)).toBe(true);
  });

  test("returns false when .devintern-code is a regular file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    await writeFile(join(tempDir, ".devintern-code"), "not a directory");
    expect(await detectCodeConfig(tempDir)).toBe(false);
  });
});
