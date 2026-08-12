import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArtifactFilenames, verifyUpdateArtifacts } from "./verify-update-artifacts.ts";

const tempDirs: string[] = [];

async function makeReleaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-desktop-update-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("extractArtifactFilenames", () => {
  test("extracts quoted, unquoted, and absolute artifact URLs", () => {
    expect(
      extractArtifactFilenames(`files:
  - url: DevIntern-PM-0.9.6-mac-arm64.zip
  - url: "DevIntern-PM-0.9.6-mac-x64.zip"
  - url: https://example.com/releases/DevIntern-PM-0.9.6.dmg?download=1
`),
    ).toEqual([
      "DevIntern-PM-0.9.6-mac-arm64.zip",
      "DevIntern-PM-0.9.6-mac-x64.zip",
      "DevIntern-PM-0.9.6.dmg",
    ]);
  });
});

describe("verifyUpdateArtifacts", () => {
  test("accepts metadata whose artifacts exist with exact filenames", async () => {
    const dir = await makeReleaseDir();
    await writeFile(
      join(dir, "latest-mac.yml"),
      "files:\n  - url: DevIntern-PM-0.9.6-mac-arm64.zip\n",
    );
    await writeFile(join(dir, "DevIntern-PM-0.9.6-mac-arm64.zip"), "archive");

    await expect(verifyUpdateArtifacts(dir)).resolves.toBeUndefined();
  });

  test("rejects the dot-normalized filename mismatch that breaks GitHub updates", async () => {
    const dir = await makeReleaseDir();
    await writeFile(
      join(dir, "latest-mac.yml"),
      "files:\n  - url: DevIntern-PM-0.9.6-mac-arm64.zip\n",
    );
    await writeFile(join(dir, "DevIntern.PM-0.9.6-mac-arm64.zip"), "archive");

    await expect(verifyUpdateArtifacts(dir)).rejects.toThrow(
      "latest-mac.yml: missing DevIntern-PM-0.9.6-mac-arm64.zip",
    );
  });

  test("rejects a directory without update metadata", async () => {
    const dir = await makeReleaseDir();

    await expect(verifyUpdateArtifacts(dir)).rejects.toThrow(
      "No latest-*.yml update metadata found",
    );
  });
});
