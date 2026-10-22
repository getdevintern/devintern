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

import { homedir } from "os";

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
 *   `$DSH_HOME/.env` (`DSH_HOME` overrides the location).
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
 * The $HOME-relative state paths a harness writes to.
 *
 * @param harnessName - Registered harness name (e.g. "grok").
 * @returns The paths for this platform; empty when the harness keeps no state.
 */
export function harnessStatePaths(harnessName: string): string[] {
  const extra = HARNESS_STATE_PATHS_EXTRA[harnessName]?.[process.platform] ?? [];
  return [...(HARNESS_STATE_PATHS[harnessName] ?? []), ...extra];
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
