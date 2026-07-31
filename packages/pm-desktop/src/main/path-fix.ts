/**
 * GUI apps on macOS/Linux don't inherit the user's shell PATH, so agent CLIs
 * installed in ~/.local/bin, ~/.bun/bin, etc. would not be found. Append the
 * common install locations that exist on this machine.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function augmentPath(): void {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];

  const current = (process.env.PATH ?? "").split(delimiter);
  const additions = candidates.filter((dir) => !current.includes(dir) && existsSync(dir));
  if (additions.length > 0) {
    process.env.PATH = [...current, ...additions].join(delimiter);
  }
}
