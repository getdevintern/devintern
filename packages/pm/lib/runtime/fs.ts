/**
 * Runtime-agnostic file system helpers using Node.js built-ins.
 *
 * Centralizes fs access so platform concerns (Bun vs Node/Electron) are isolated.
 */

import {
  readFile as nodeReadFile,
  writeFile as nodeWriteFile,
  access,
  mkdir as nodeMkdir,
  rm as nodeRm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read a text file.
 * @param path - Absolute or relative file path.
 * @returns UTF-8 file contents.
 */
export async function readFile(path: string): Promise<string> {
  return nodeReadFile(path, "utf-8");
}

/**
 * Write a text file, creating parent directories if needed.
 * @param path - Absolute or relative file path.
 * @param content - UTF-8 string to write.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  if (dir !== ".") {
    await nodeMkdir(dir, { recursive: true });
  }
  await nodeWriteFile(path, content, "utf-8");
}

/**
 * Check whether a path exists (file or directory).
 * @param path - Path to check.
 * @returns `true` if accessible, `false` otherwise.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous path existence check.
 * @param path - Path to check.
 * @returns `true` if accessible, `false` otherwise.
 */
export function pathExistsSync(path: string): boolean {
  return existsSync(path);
}

/**
 * Create a directory and all intermediate directories.
 * @param path - Directory path to create.
 */
export async function mkdir(path: string): Promise<void> {
  await nodeMkdir(path, { recursive: true });
}

/**
 * Remove a file or directory recursively.
 * @param path - Path to remove.
 */
export async function rm(path: string): Promise<void> {
  await nodeRm(path, { recursive: true, force: true });
}
