/**
 * Per-harness state directories under $HOME.
 *
 * Sandbox providers grant read+write access to the state a harness keeps
 * outside the repository (auth tokens, session transcripts, lock files).
 * Everything else under $HOME stays read-only, so a harness that is missing
 * from this map can still start (its auth file is readable) and then fail on
 * the first state write — which is what happened to grok before `~/.grok` was
 * added.
 *
 * Shared by the exec-wrapper providers (`nono`, `srt`) so the two cannot drift
 * apart.
 */

import { existsSync, mkdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";

/**
 * Harness name → $HOME paths the agent needs read+write access to.
 *
 * Paths are relative to $HOME. Every entry is verified against the harness's
 * own docs or the installed CLI:
 *
 * - claude-code: `~/.claude` (settings, projects, session history) and the
 *   top-level `~/.claude.json`.
 * - codex: `~/.codex` (auth.json, sessions, history).
 * - antigravity / gemini: `~/.gemini` (legacy Gemini CLI layout).
 * - cursor: `~/.cursor` (IDE state) and `~/.config/cursor` (cursor-agent chats).
 * - opencode: `~/.config/opencode`, `~/.local/share/opencode`,
 *   `~/.local/state/opencode`.
 * - grok: `~/.grok` — every grok state file lives there: `auth.json` (+ its
 *   `.lock`), `active_sessions.json`, `sessions/`, `logs/`, `worktrees.db`,
 *   `config.toml`, `models_cache.json` (verified on grok 1.0.62).
 * - cline: `~/.cline` — global config, agents, rules, workflows and sessions
 *   (`CLINE_DIR` overrides the location).
 * - deepseek (official dsh): `~/.dsh` — profiles, sessions, settings, logs and
 *   `$DSH_HOME/.env`. When `DSH_HOME` is set, DevIntern expands `~`, resolves
 *   relative values against the workspace (matching dsh), and grants that
 *   directory instead — but only a `.dsh*` directory directly under `$HOME`
 *   (e.g. `~/.dsh-custom` or `~/.dsh/profiles`) or one inside the workspace.
 *   Other locations need {@link DSH_HOME_CUSTOM_ROOT_ENV}=1.
 * - reasonix (community): `~/.reasonix` — `config.json`, skills and per-project
 *   overrides.
 * - goose: `~/.config/goose` (config.yaml), `~/.local/share/goose` (sessions,
 *   recipes, logs) and `~/.local/state/goose`.
 * - kilo-code: `~/.config/kilo`, `~/.local/share/kilo`, `~/.local/state/kilo`
 *   and `~/.cache/kilo` (XDG layout for app name "kilo").
 * - kimi: `~/.kimi` — the CLI's whole home (config, MCP servers, input history,
 *   sessions).
 * - qwen: `~/.qwen` — `settings.json`, `installation_id`, memory
 *   (`QWEN_HOME` overrides the location).
 * - pi: `~/.pi` — `auth.json`, sessions, model store, skills and themes.
 *
 * A directory grant covers the lock files inside it, so only top-level files
 * need an explicit file grant (the `.json` special case in the providers).
 */
export const HARNESS_STATE_PATHS: Record<string, string[]> = {
  "claude-code": [".claude", ".claude.json"],
  codex: [".codex"],
  // agy keeps state under ~/.gemini (legacy Gemini CLI layout)
  antigravity: [".gemini"],
  gemini: [".gemini"],
  // cursor-agent writes chats under ~/.config/cursor; IDE state stays in ~/.cursor
  cursor: [".cursor", ".config/cursor"],
  opencode: [".config/opencode", ".local/share/opencode", ".local/state/opencode"],
  grok: [".grok"],
  cline: [".cline"],
  deepseek: [".dsh"],
  reasonix: [".reasonix"],
  goose: [".config/goose", ".local/share/goose", ".local/state/goose"],
  "kilo-code": [".config/kilo", ".local/share/kilo", ".local/state/kilo", ".cache/kilo"],
  kimi: [".kimi"],
  qwen: [".qwen"],
  pi: [".pi"],
};

/**
 * Platform-specific extras for harnesses whose state layout follows the OS
 * conventions of their runtime. goose keeps a legacy macOS location next to
 * the documented `~/.config/goose` + `~/.local/share/goose` pair.
 */
export const HARNESS_STATE_PATHS_EXTRA: Record<
  string,
  Partial<Record<NodeJS.Platform, string[]>>
> = {
  goose: { darwin: ["Library/Application Support/Block/goose"] },
};

/**
 * Real process environment captured when this module first loads. The host
 * merges the repository-controlled `.devintern-code/.env` into `process.env`
 * afterwards, so the custom-root opt-in must be read from this snapshot:
 * otherwise a project file could point state at `~/.ssh` and widen the
 * sandbox grant. Mirrors `resolver.ts`'s `STARTUP_ENV`.
 *
 * `DSH_HOME` is deliberately *not* snapshot-gated: the dsh child inherits the
 * post-dotenv `process.env`, so it creates `$DSH_HOME/profiles/headless` from
 * that value. Granting the pre-dotenv `~/.dsh` instead makes dsh die with
 * `EACCES`, which surfaces as an unavailable harness. The `.dsh*`/workspace
 * check below still prevents a repository file from widening the grant.
 */
const STARTUP_ENV: NodeJS.ProcessEnv = { ...process.env };

/**
 * Absolute state directory overrides a harness reads from its own environment.
 *
 * When unset, the corresponding `HARNESS_STATE_PATHS` default applies.
 *
 * @param harnessName - Registered harness name.
 * @param snapshot - Trusted startup environment that gates the custom-root
 *   opt-in. Defaults to {@link STARTUP_ENV}.
 * @param env - Environment the harness child actually receives. Defaults to
 *   the live `process.env` (including values merged from the repository
 *   `.env`), matching what dsh itself reads.
 */
function stateDirOverride(
  harnessName: string,
  snapshot: NodeJS.ProcessEnv = STARTUP_ENV,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (harnessName !== "deepseek") {
    return undefined;
  }
  const dshHome = env.DSH_HOME?.trim();
  if (!dshHome) {
    return undefined;
  }
  const resolved = canonicalizeStatePath(expandHomePath(dshHome));
  const home = canonicalizeStatePath(resolveHomeDir());
  const cwd = canonicalizeStatePath(process.cwd());
  if (isAllowedCustomStateRoot(resolved, home, cwd, snapshot)) {
    return resolved;
  }
  warnUntrustedDshHomeOnce(resolved);
  return undefined;
}

/** Env var that explicitly trusts a `DSH_HOME` outside `$HOME`/the workspace. */
export const DSH_HOME_CUSTOM_ROOT_ENV = "DEVINTERN_SANDBOX_ALLOW_CUSTOM_DSH_HOME";

/** Emitted-at-most-once guard for the untrusted-state-root warning. */
const warnedDshHomes = new Set<string>();

/**
 * Expand a leading `~` the way dsh does.
 *
 * @param path - Raw path from `DSH_HOME`.
 * @returns Path with `~` expanded, or the original value.
 */
function expandHomePath(path: string): string {
  if (path === "~") {
    return resolveHomeDir();
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(resolveHomeDir(), path.slice(2));
  }
  return path;
}

/**
 * Resolve symlinks for an existing path; leave non-existent paths lexical.
 *
 * @param path - Absolute path to normalize.
 * @returns The real path when it exists, else the input.
 */
function realpathIfExists(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * Resolve symlinks in every path component that already exists.
 *
 * {@link realpathIfExists} only resolves a path whose final component exists,
 * which leaves a not-yet-created `DSH_HOME` lexical. A repository can then
 * point `DSH_HOME` at `link/dsh-state` while `link` is a symlink to a directory
 * outside the workspace: the lexical path looks trusted, `mkdirSync` creates
 * the directory on the host, and the next (post-creation) check rejects it.
 * Walking up to the deepest existing ancestor resolves those symlinks before
 * validation, so the create and the grant always make the same decision.
 *
 * @param path - Absolute or relative path to normalize.
 * @returns The physical path with any non-existent trailing components kept.
 */
function canonicalizeStatePath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    missing.unshift(basename(existing));
    existing = parent;
  }
  const real = realpathIfExists(existing);
  return missing.length > 0 ? join(real, ...missing) : real;
}

/**
 * Whether `child` sits strictly below `parent`.
 *
 * @param parent - Absolute parent directory.
 * @param child - Absolute candidate path.
 * @returns True for a descendant, false for the parent itself or anything outside.
 */
function isStrictlyWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether `path` is a dsh-owned state directory directly under `home`.
 *
 * Only the first segment below `$HOME` counts: `~/.dsh`, `~/.dsh-custom` and
 * `~/.dsh/profiles` are dsh state, while other `$HOME` subtrees such as
 * `~/.ssh` (or `~/.ssh/.dsh`) are not. This keeps a repository-selected
 * `DSH_HOME` from widening the sandbox grant to unrelated credentials.
 *
 * @param path - Normalized absolute `DSH_HOME`.
 * @param home - Normalized `$HOME`.
 * @returns Whether the path is a dsh state directory under `$HOME`.
 */
function isDshStateDirUnderHome(path: string, home: string): boolean {
  if (home === resolve("/") || !isStrictlyWithin(home, path)) {
    return false;
  }
  const firstSegment = relative(home, path).split(/[\\/]/)[0] ?? "";
  return firstSegment.startsWith(".dsh");
}

/**
 * Whether a custom `DSH_HOME` may receive a read-write sandbox grant.
 *
 * Trusted roots are a `.dsh*` directory directly under `$HOME` (not `$HOME`
 * itself, which would grant the whole home directory) or the workspace
 * directory. Other `$HOME` subtrees, the filesystem root, and any location
 * outside those roots need the explicit
 * {@link DSH_HOME_CUSTOM_ROOT_ENV} opt-in.
 *
 * @param path - Normalized absolute `DSH_HOME`.
 * @param home - Normalized `$HOME`.
 * @param cwd - Normalized workspace directory.
 * @param env - Trusted environment snapshot holding the opt-in.
 * @returns Whether the path is safe to grant.
 */
function isAllowedCustomStateRoot(
  path: string,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv = STARTUP_ENV,
): boolean {
  if (path === resolve("/")) {
    return false;
  }
  if (env[DSH_HOME_CUSTOM_ROOT_ENV] === "1") {
    return true;
  }
  // A worker launched from `/` (systemd without WorkingDirectory, cron) has no
  // meaningful workspace: treating `/` as one would trust any absolute path.
  if (cwd === resolve("/")) {
    return false;
  }
  const inWorkspace = isStrictlyWithin(cwd, path) || path === cwd;
  return isDshStateDirUnderHome(path, home) || inWorkspace;
}

/**
 * Warn once when `DSH_HOME` points outside the sandbox's trusted roots.
 *
 * @param path - Normalized custom state directory that was not granted.
 */
function warnUntrustedDshHomeOnce(path: string): void {
  if (warnedDshHomes.has(path)) {
    return;
  }
  warnedDshHomes.add(path);
  console.warn(
    `⚠️  DSH_HOME=${path} is not a trusted sandbox state location (a .dsh* directory under ` +
      "$HOME or the workspace; $HOME itself, other $HOME subtrees and the filesystem root are " +
      "excluded), so DevIntern will not grant it read-write access. Move DSH_HOME to a .dsh* " +
      `directory under $HOME or into the workspace, or set ` +
      `${DSH_HOME_CUSTOM_ROOT_ENV}=1 to trust that location.`,
  );
}

/**
 * The state paths a harness writes to.
 *
 * Normally returns `$HOME`-relative paths. A harness that honors its own home
 * override (currently dsh's `DSH_HOME`) returns that normalized absolute
 * directory instead so sandbox providers grant the real location. An
 * untrusted override (not a `.dsh*` directory directly under `$HOME` and not
 * inside the workspace) is ignored with a warning and the default state path
 * is returned.
 *
 * @param harnessName - Registered harness name (e.g. "grok").
 * @param snapshot - Trusted startup environment that gates the custom-root
 *   opt-in. Defaults to {@link STARTUP_ENV}, so repository-controlled `.env`
 *   values cannot widen the grant.
 * @param env - Environment the harness child actually receives. Defaults to
 *   the live `process.env`, so a `DSH_HOME` merged from the repository `.env`
 *   is granted where dsh will actually write.
 * @returns Paths relative to $HOME, or absolute override paths.
 */
export function harnessStatePaths(
  harnessName: string,
  snapshot: NodeJS.ProcessEnv = STARTUP_ENV,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = stateDirOverride(harnessName, snapshot, env);
  if (override) {
    return [override];
  }
  const extra = HARNESS_STATE_PATHS_EXTRA[harnessName]?.[process.platform] ?? [];
  return [...(HARNESS_STATE_PATHS[harnessName] ?? []), ...extra];
}

/**
 * Create a trusted custom harness state directory before it is granted.
 *
 * Sandbox providers only grant paths that already exist, so a fresh
 * `DSH_HOME` (a custom state directory dsh has not created yet) would
 * otherwise receive no grant and the sandboxed dsh could not create its
 * `profiles/`, sessions or logs. Only a path that passed
 * {@link isAllowedCustomStateRoot} is created; untrusted values are left
 * untouched (and warned about by {@link stateDirOverride}).
 *
 * When there is no override, the default `~/.dsh` state directory is created
 * for deepseek. Headless runs authenticate with `DEEPSEEK_API_KEY` and never
 * launch the dsh GUI, so on a fresh install the default directory does not
 * exist yet; without this the first sandboxed run would get no state grant at
 * all.
 *
 * @param harnessName - Registered harness name.
 * @param snapshot - Trusted startup environment that gates the custom-root
 *   opt-in. Defaults to {@link STARTUP_ENV}.
 * @param env - Environment the harness child actually receives. Defaults to
 *   the live `process.env`.
 * @returns The trusted absolute directory (custom override or created default),
 *   or undefined when there is nothing to create or creation failed.
 */
export function ensureHarnessStateDir(
  harnessName: string,
  snapshot: NodeJS.ProcessEnv = STARTUP_ENV,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = stateDirOverride(harnessName, snapshot, env);
  const target =
    override ?? (harnessName === "deepseek" ? join(resolveHomeDir(), ".dsh") : undefined);
  if (!target) {
    return undefined;
  }
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    return undefined;
  }
  return target;
}

/**
 * The state paths a harness writes to as absolute filesystem paths.
 *
 * Resolves relative entries against the sandboxed home directory and keeps
 * absolute overrides (e.g. a custom `DSH_HOME`) untouched.
 *
 * @param harnessName - Registered harness name.
 * @param home - Home directory the sandboxed agent will see. Defaults to {@link resolveHomeDir}.
 * @param snapshot - Trusted startup environment that gates the custom-root
 *   opt-in. Defaults to {@link STARTUP_ENV}.
 * @param env - Environment the harness child actually receives. Defaults to
 *   the live `process.env`.
 * @returns Absolute paths for sandbox grants.
 */
export function harnessStateAbsolutePaths(
  harnessName: string,
  home: string = resolveHomeDir(),
  snapshot: NodeJS.ProcessEnv = STARTUP_ENV,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return harnessStatePaths(harnessName, snapshot, env).map((path) =>
    isAbsolute(path) ? path : join(home, path),
  );
}

/**
 * The home directory the sandboxed agent will see.
 *
 * `process.env.HOME` wins over the passwd database because the agent process
 * inherits the environment: if `$HOME` points elsewhere, the agent looks for
 * its state there, so the grants have to follow. `dotenv` never overrides an
 * already-set variable, so a repository `.env` cannot redirect it.
 *
 * @returns The absolute home directory.
 */
export function resolveHomeDir(): string {
  return process.env.HOME || homedir();
}
