import { chmodSync, writeFileSync } from "fs";

/**
 * Write a file that holds secrets (tokens, env files) and leave it owner-only.
 *
 * The `mode` option only applies when the file is created, so an existing file
 * keeps its old permissions; the follow-up `chmodSync` tightens it to 0600.
 *
 * @param path - File to create or overwrite
 * @param content - UTF-8 file content
 */
export function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
