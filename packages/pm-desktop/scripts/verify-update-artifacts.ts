#!/usr/bin/env bun
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

const UPDATE_METADATA_PATTERN = /^latest(?:-[a-z0-9-]+)?\.yml$/;
const ARTIFACT_URL_PATTERN = /^\s*(?:-\s+)?url:\s*(.+?)\s*$/;

/** Extract artifact filenames referenced by electron-builder update metadata. */
export function extractArtifactFilenames(metadata: string): string[] {
  const filenames: string[] = [];

  for (const line of metadata.split(/\r?\n/)) {
    const value = line.match(ARTIFACT_URL_PATTERN)?.[1];
    if (!value) continue;

    const unquoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
    const pathname = URL.canParse(unquoted)
      ? new URL(unquoted).pathname
      : (unquoted.split(/[?#]/, 1)[0] ?? unquoted);
    const filename = basename(decodeURIComponent(pathname));
    if (filename) filenames.push(filename);
  }

  return filenames;
}

/** Ensure every artifact URL in latest-*.yml has an exact local filename match. */
export async function verifyUpdateArtifacts(releaseDir: string): Promise<void> {
  const entries = await readdir(releaseDir);
  const metadataFiles = entries.filter((entry) => UPDATE_METADATA_PATTERN.test(entry)).sort();
  if (metadataFiles.length === 0) {
    throw new Error(`No latest-*.yml update metadata found in ${releaseDir}`);
  }

  const failures: string[] = [];
  for (const metadataFile of metadataFiles) {
    const metadata = await readFile(resolve(releaseDir, metadataFile), "utf8");
    const artifactFilenames = extractArtifactFilenames(metadata);
    if (artifactFilenames.length === 0) {
      failures.push(`${metadataFile} does not reference any artifact URLs`);
      continue;
    }

    for (const artifactFilename of artifactFilenames) {
      try {
        const artifact = await stat(resolve(releaseDir, artifactFilename));
        if (!artifact.isFile()) failures.push(`${metadataFile}: ${artifactFilename} is not a file`);
      } catch {
        failures.push(`${metadataFile}: missing ${artifactFilename}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Update metadata references missing artifacts:\n${failures.join("\n")}`);
  }

  console.log(`Verified ${metadataFiles.length} update metadata file(s) in ${releaseDir}`);
}

if (import.meta.main) {
  const releaseDir = resolve(process.argv[2] ?? "release");
  await verifyUpdateArtifacts(releaseDir);
}
