import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read a text file, or return `null` when it does not exist.
 *
 * @param path - Absolute file path.
 * @returns File contents, or `null` when missing.
 */
export async function readTextFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write a text file, creating parent directories as needed.
 *
 * @param path - Absolute file path.
 * @param content - File contents to write.
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * Delete a file if it exists. No-op when missing.
 *
 * @param path - Absolute file path.
 */
export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Open a URL in the system default browser (macOS, Windows, or Linux). */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const [command, ...args] =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command!, args, {
      stdio: "ignore",
      detached: true,
    });
    proc.once("error", reject);
    proc.once("spawn", () => {
      proc.unref();
      resolve();
    });
  });
}
