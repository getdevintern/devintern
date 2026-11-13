/**
 * Local report paths.
 *
 * The public report API must not import `@devintern/utils`, so this module
 * reimplements the small "nearest .devintern-code" lookup without the shared
 * dependency. CLI entry points pass the exact runtime state directory instead.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Resolve the report config directory, nearest to `startDir` unless supplied. */
export function resolveReportConfigDir(configDir?: string, startDir = process.cwd()): string {
  if (configDir?.trim()) return resolve(configDir.trim());
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, ".devintern-code");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(resolve(startDir), ".devintern-code");
}

/** Resolve the local report spool directory. */
export function resolveReportDir(configDir?: string, startDir = process.cwd()): string {
  return join(resolveReportConfigDir(configDir, startDir), "reports");
}
