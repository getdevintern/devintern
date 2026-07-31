import { describe, expect, test } from "bun:test";
import { readdir, readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { getModuleDir } from "./lib/runtime/path.js";

/**
 * Recursively collect all .ts and .tsx files under a directory (excluding .d.ts and test files).
 */
async function collectTsFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTsFiles(fullPath, files);
    } else if (
      entry.isFile() &&
      (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) &&
      !fullPath.endsWith(".d.ts") &&
      !fullPath.endsWith(".test.ts") &&
      !fullPath.endsWith(".test.tsx")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("No Bun runtime APIs in application code", () => {
  test("source files should not contain Bun.* runtime calls", async () => {
    const root = getModuleDir(import.meta.url);
    const sourceFiles = [join(root, "index.ts"), ...(await collectTsFiles(join(root, "lib")))];

    const forbiddenPattern = /\bBun\.[$a-zA-Z_][a-zA-Z0-9_$]*\b/;
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = await readFileAsync(file, "utf-8");
      // Strip block comments from the entire file first, then split into lines
      const strippedContent = content.replace(/\/\*[\s\S]*?\*\//g, "");
      const lines = strippedContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Allow line comments that mention Bun as a dev tool, but not actual API calls
        const codePart = line.replace(/\/\/.*$/, "");
        if (forbiddenPattern.test(codePart)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      console.error("Bun runtime API violations found:\n" + violations.join("\n"));
    }

    expect(violations).toEqual([]);
  });
});
