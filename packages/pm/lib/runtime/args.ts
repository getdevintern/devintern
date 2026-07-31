/**
 * Runtime-agnostic CLI argument helper.
 *
 * Wraps `process.argv` for portability across Bun and Node.js/Electron.
 */

/**
 * Return the CLI arguments after the script name (skips `node`/`bun` and the entry file).
 * @returns Array of positional/flag arguments.
 */
export function getArgs(): string[] {
  return process.argv.slice(2);
}
