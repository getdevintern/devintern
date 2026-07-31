/**
 * Runtime-agnostic module directory resolver.
 *
 * Replaces `import.meta.dir` with a portable `fileURLToPath(import.meta.url)`
 * based helper that works under both Bun and Node.js/Electron.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get the directory path of the current module.
 *
 * Use like:
 * ```ts
 * const __dirname = getModuleDir(import.meta.url);
 * ```
 *
 * @param metaUrl - `import.meta.url` from the calling module.
 * @returns Absolute directory path.
 */
export function getModuleDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}
