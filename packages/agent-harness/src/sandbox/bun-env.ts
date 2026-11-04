/**
 * Writable Bun install/temp roots for sandboxed runs.
 *
 * Bun defaults `BUN_INSTALL` to `~/.bun`, which sandbox providers keep
 * read-only (the policy only grants most of `$HOME` as readable). A child
 * `bun install` / `bun add` therefore fails with
 *
 *   error: EACCES accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL
 *
 * before it resolves a single package. Providers overlay these environment
 * variables so dependency work lands in a disposable cache the sandbox already
 * trusts, instead of the user's real Bun installation.
 */

import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Bun environment additions plus the writable root a provider must grant. */
export interface BunSandboxEnv {
  /** Environment overlay for the wrapped child. */
  env: { BUN_INSTALL: string; BUN_TMPDIR: string };
  /** Root directory containing both paths; grant read+write. */
  writablePath: string;
}

/**
 * Resolve and create a sandbox-local Bun install/temp root.
 *
 * Paths are stable per host so a provider's grant and preflight caches are
 * reused across runs. Directories are created when missing and existing
 * contents are left untouched (a warm install cache avoids re-downloading
 * packages on every run).
 *
 * @param base - Root cache directory. Defaults to `<os.tmpdir()>/devintern-bun`.
 * @returns The env overlay and the single writable root to grant.
 */
export function sandboxBunEnv(base: string = join(tmpdir(), "devintern-bun")): BunSandboxEnv {
  const install = join(base, "install");
  const temp = join(base, "tmp");
  mkdirSync(install, { recursive: true });
  mkdirSync(temp, { recursive: true });
  return {
    env: { BUN_INSTALL: install, BUN_TMPDIR: temp },
    writablePath: base,
  };
}
