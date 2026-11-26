/**
 * `worker doctor` harness check: can the worker spawn the configured agent CLI?
 *
 * The check resolves the `AGENT_HARNESS` chain against the environment the
 * worker's task subprocess would see, not this process's `process.env`:
 *
 * - `AGENT_HARNESS` comes from the worker's environment (process env plus the
 *   workspace `.env`). The worker resolves its failover chain there and pins
 *   every task subprocess to the active entry.
 * - CLI path overrides (`AGENT_CLI_PATH`, `<HARNESS>_CLI_PATH`, ...) come from
 *   each repository's composed env (`buildRepoEnv` precedence: process env <
 *   workspace `.env` < repo `env_file` < `[repos.env]`), because the task
 *   subprocess resolves the executable from that env. A team-acquired task
 *   (`buildTeamTaskEnv`) or a run borrowing a team's credentials
 *   (`buildRepoRunEnv`) also layers the team's namespaced values, `env_file`,
 *   and `[teams.env]` on top, so each (repo, team) pair the worker can spawn
 *   gets its own scope.
 *
 * Entry selection happens once, in the worker's environment: the worker drops
 * chain entries whose CLI it cannot find there and pins task subprocesses to
 * the surviving entries, so an entry installed only through a repo env is
 * skipped. The check resolves the chain there first, warns about skipped
 * entries, and then checks per repository that the selected entries spawn,
 * resolving each fallback the way its pinned subprocess does (there the
 * global `AGENT_CLI_PATH` applies to whichever entry is active).
 *
 * A configured path that does not resolve is reported with its key, value,
 * and the file that set it.
 */

import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { resolveExecutablePath, resolveHarnessChainSync } from "@devintern/agent-harness";
import type { HarnessChainEntry } from "@devintern/agent-harness";
import type { TeamConfig, WorkspaceConfig } from "../workspace/config";
import { namespacedTeamEnv, parseEnvFile } from "../workspace/env";
import { effectiveRoutingRules } from "../workspace/router";
import { workspaceEnvPath } from "../workspace/paths";
import { withEnvOverlay } from "./readiness";
import type { ReadinessCheck } from "./readiness";

type Env = Record<string, string | undefined>;

/** One env layer with a human-readable origin (a file path or "the environment"). */
export interface HarnessEnvLayer {
  source: string;
  values: Env;
  /** Why the file could not be read (a directory, EACCES, ...); `values` is then empty. */
  readError?: string;
}

/** The composed env one agent spawn sees, with its layers in precedence order. */
export interface HarnessEnvScope {
  /** Repository the scope belongs to; absent for the workspace-level scope. */
  repo?: string;
  /** Team whose credential layers the scope includes, if any. */
  team?: string;
  env: Env;
  /** Layers in precedence order (later wins), for naming where a value came from. */
  layers: HarnessEnvLayer[];
}

const PROCESS_ENV_SOURCE = "the environment";

/** A dotenv file layer; an unreadable file becomes a layer carrying the error, not a throw. */
function fileLayer(path: string): HarnessEnvLayer {
  try {
    return { source: path, values: parseEnvFile(path) };
  } catch (error) {
    const readError = error instanceof Error ? error.message : String(error);
    return { source: path, values: {}, readError };
  }
}

/** Workspace config fields that decide which spawn environments exist. */
export type HarnessScopeConfig = Pick<WorkspaceConfig, "repos" | "teams" | "routing">;

/**
 * Repos a team's tasks can route to: its fixed `repo`, else the repos its
 * effective routing rules name, else (one-repo workspace) the only repo.
 */
function teamRepoNames(config: HarnessScopeConfig, team: TeamConfig): Set<string> {
  if (team.repo) return new Set([team.repo]);
  const names = new Set(effectiveRoutingRules(config, team.name).map((rule) => rule.repo));
  if (config.repos.length === 1) names.add(config.repos[0]!.name);
  return names;
}

/**
 * Harness scopes for a workspace: one per spawn environment the worker can
 * build, or a single workspace-level scope when no repository is configured.
 *
 * Each repository gets its plain repo env (`buildRepoEnv`), unless exactly one
 * team is fixed to it: then its ad-hoc and scheduled runs borrow that team's
 * credentials (`resolveCredentialTeam`), so the plain env is never spawned.
 * Each (repo, team) pair a team can route to gets the repo env with the
 * team layers on top (`buildTeamTaskEnv`).
 *
 * @param processEnv - The worker's environment before the workspace `.env` applies.
 * @param workspaceDir - Workspace home holding `.env` and `workspace.toml`.
 * @param config - Repositories, teams, and routing rules the worker serves.
 */
export function harnessEnvScopes(
  processEnv: Env,
  workspaceDir: string,
  config: HarnessScopeConfig = { repos: [], teams: [], routing: [] },
): HarnessEnvScope[] {
  const workspacePath = workspaceEnvPath(workspaceDir);
  const workspaceLayer = fileLayer(workspacePath);
  const base: HarnessEnvLayer[] = [
    { source: PROCESS_ENV_SOURCE, values: processEnv },
    workspaceLayer,
  ];
  if (config.repos.length === 0) return [scopeFromLayers(base)];
  const tomlPath = join(workspaceDir, "workspace.toml");
  const resolve = (path: string) => (isAbsolute(path) ? path : join(workspaceDir, path));
  const scopes: HarnessEnvScope[] = [];
  for (const repo of config.repos) {
    const layers = [...base];
    if (repo.envFile) layers.push(fileLayer(resolve(repo.envFile)));
    if (Object.keys(repo.env).length > 0) {
      layers.push({ source: `[repos.env] of "${repo.name}" in ${tomlPath}`, values: repo.env });
    }
    const fixedTeams = config.teams.filter((team) => team.repo === repo.name);
    if (fixedTeams.length !== 1) scopes.push(scopeFromLayers(layers, repo.name));
    for (const team of config.teams) {
      if (!teamRepoNames(config, team).has(repo.name)) continue;
      const teamLayers = [...layers];
      const namespaced = namespacedTeamEnv(workspaceLayer.values as Record<string, string>, team);
      if (Object.keys(namespaced).length > 0) {
        teamLayers.push({
          source: `${workspacePath} (team "${team.name}" values)`,
          values: namespaced,
        });
      }
      if (team.envFile) teamLayers.push(fileLayer(resolve(team.envFile)));
      if (Object.keys(team.env).length > 0) {
        teamLayers.push({
          source: `[teams.env] of "${team.name}" in ${tomlPath}`,
          values: team.env,
        });
      }
      scopes.push(scopeFromLayers(teamLayers, repo.name, team.name));
    }
  }
  return scopes;
}

function scopeFromLayers(layers: HarnessEnvLayer[], repo?: string, team?: string): HarnessEnvScope {
  const env: Env = {};
  for (const layer of layers) Object.assign(env, layer.values);
  return { ...(repo ? { repo } : {}), ...(team ? { team } : {}), env, layers };
}

/**
 * Env keys that can name a harness executable, in the resolver's order
 * (`resolveEnvHarnessPath` / `getHarnessCliCommand`).
 */
function cliPathKeys(harnessName: string): string[] {
  const prefix = harnessName.toUpperCase().replace(/-/g, "_");
  return [
    "AGENT_CLI_PATH",
    `${prefix}_CLI_PATH`,
    ...(harnessName === "antigravity" ? ["AGY_CLI_PATH", "GEMINI_CLI_PATH"] : []),
    ...(harnessName === "claude-code" ? ["CLAUDE_CLI_PATH"] : []),
  ];
}

/**
 * The overlay a scope is evaluated under: its values, with any harness
 * selection or CLI path key it does not set cleared, so a value left in this
 * process cannot stand in for one the subprocess would not see.
 */
function overlayFor(scope: HarnessEnvScope, rawHarness: string | undefined): Env {
  const overlay: Env = { ...scope.env, AGENT_HARNESS: rawHarness };
  for (const key of Object.keys(process.env)) {
    if (key.endsWith("_CLI_PATH") && !(key in scope.env)) overlay[key] = undefined;
  }
  return overlay;
}

type ScopeVerdict = Pick<ReadinessCheck, "status" | "detail" | "hint">;

/** "in <file>" or "in the environment": the last scope layer that set `key` to `value`. */
function whereSet(scope: HarnessEnvScope, key: string, value: string): string {
  const source =
    [...scope.layers].reverse().find((layer) => layer.values[key] === value)?.source ??
    PROCESS_ENV_SOURCE;
  return source === PROCESS_ENV_SOURCE ? "in the environment" : `in ${source}`;
}

/** A configured (not default) path that does not resolve, with where it was set. */
function configuredPathProblem(
  entry: HarnessChainEntry,
  scope: HarnessEnvScope,
): ScopeVerdict | undefined {
  const key = cliPathKeys(entry.name).find((candidate) => scope.env[candidate] === entry.path);
  if (!key) return undefined;
  const where = whereSet(scope, key, entry.path);
  const bare = !entry.path.includes("/") && !entry.path.includes("\\");
  const problem = bare
    ? "is not on PATH"
    : existsSync(resolveExecutablePath(entry.path))
      ? "is not executable"
      : "does not exist";
  return {
    status: "fail",
    detail: `${entry.name}: ${key}=${entry.path} (set ${where}) ${problem}`,
    hint: `Point ${key} ${where} at the agent CLI executable, or remove it to use the CLI on PATH`,
  };
}

function resolveInScope(scope: HarnessEnvScope, rawHarness: string | undefined) {
  return withEnvOverlay(overlayFor(scope, rawHarness), async () =>
    resolveHarnessChainSync({ raw: rawHarness, warnDeprecated: false }),
  );
}

/**
 * The chain as the worker resolves it (`startWorkerFailover`, in the worker's
 * own env). Returns the entries it keeps, which are the only ones task
 * subprocesses are pinned to, and a warning when it skips some.
 */
async function selectWorkerEntries(
  env: Env,
  rawHarness: string | undefined,
): Promise<{ selected: string | undefined; verdict?: ScopeVerdict }> {
  const scope: HarnessEnvScope = { env, layers: [{ source: PROCESS_ENV_SOURCE, values: env }] };
  const chain = await resolveInScope(scope, rawHarness);
  // Nothing installed: the worker keeps the full parsed list, so each repo
  // scope resolves the chain as configured and decides on its own.
  if (!chain.entries.some((entry) => entry.installed)) return { selected: rawHarness };
  const selected = chain.entries.map((entry) => entry.name).join(",");
  if (chain.issues.length === 0) return { selected };
  return {
    selected,
    verdict: {
      status: "warn",
      detail: `worker failover: ${chain.issues.map((issue) => issue.message).join(" ")}`,
      hint:
        "The worker picks AGENT_HARNESS entries using the workspace .env only; " +
        "set the skipped entry's <HARNESS>_CLI_PATH there (a repo env_file or [repos.env] " +
        "does not count), or remove it from AGENT_HARNESS",
    },
  };
}

async function evaluateScope(
  scope: HarnessEnvScope,
  rawHarness: string | undefined,
): Promise<ScopeVerdict> {
  const unreadable = scope.layers.find((layer) => layer.readError !== undefined);
  if (unreadable) {
    return {
      status: "fail",
      detail: `cannot read ${unreadable.source}: ${unreadable.readError}`,
      hint: `Make ${unreadable.source} a readable env file, or remove it from workspace.toml`,
    };
  }
  const chain = await resolveInScope(scope, rawHarness);
  const installed = chain.entries.filter((entry) => entry.installed);
  const names = chain.entries.map((entry) => entry.name).join(", ");
  if (installed.length === 0) {
    const configured = chain.entries
      .map((entry) => configuredPathProblem(entry, scope))
      .find((verdict) => verdict !== undefined);
    if (configured) return configured;
    return {
      status: "fail",
      detail: chain.issues[0]?.message ?? `no harness CLI found for AGENT_HARNESS=${names}`,
      hint: "Install the agent CLI, or set AGENT_HARNESS / <HARNESS>_CLI_PATH in the workspace .env",
    };
  }
  const warnings: ScopeVerdict[] = [];
  if (chain.issues.length > 0) {
    warnings.push({
      status: "warn",
      detail: chain.issues.map((issue) => issue.message).join(" "),
      hint: "Remove or install the skipped AGENT_HARNESS entries in the workspace .env",
    });
  }
  const fallback = await fallbackPathProblem(scope, chain.entries);
  if (fallback) warnings.push(fallback);
  if (warnings.length === 0) return { status: "ok", detail: names };
  return {
    status: "warn",
    detail: warnings.map((warning) => warning.detail).join(" "),
    hint: warnings.map((warning) => warning.hint).join("; "),
  };
}

/**
 * A fallback entry whose pinned task subprocess would spawn another binary.
 *
 * Every task subprocess is pinned to one entry (`childEnv` sets
 * `AGENT_HARNESS` to the active harness), so in the subprocess that entry is
 * the primary and the global `AGENT_CLI_PATH` applies to it as well. The
 * multi-entry chain applies `AGENT_CLI_PATH` to the first entry only, so each
 * fallback is resolved again on its own, the way its subprocess resolves it.
 */
async function fallbackPathProblem(
  scope: HarnessEnvScope,
  entries: readonly HarnessChainEntry[],
): Promise<ScopeVerdict | undefined> {
  const globalPath = scope.env.AGENT_CLI_PATH;
  if (!globalPath) return undefined;
  const affected: string[] = [];
  for (const entry of entries.slice(1)) {
    const pinned = await resolveInScope(scope, entry.name);
    const path = pinned.entries[0]?.path ?? globalPath;
    if (path !== entry.path) affected.push(entry.name);
  }
  if (affected.length === 0) return undefined;
  const where = whereSet(scope, "AGENT_CLI_PATH", globalPath);
  return {
    status: "warn",
    detail:
      `${affected.join(", ")}: after failover the task runs AGENT_CLI_PATH=${globalPath} ` +
      `(set ${where}) instead of its own CLI`,
    hint:
      `Replace AGENT_CLI_PATH ${where} with the primary harness's <HARNESS>_CLI_PATH ` +
      "(for example CLAUDE_CODE_CLI_PATH), so each failover entry keeps its own CLI",
  };
}

/** `repo "app"` or `repo "app" (team "platform")`; undefined for the workspace scope. */
function scopeLabel(scope: HarnessEnvScope): string | undefined {
  if (!scope.repo) return undefined;
  return scope.team ? `repo "${scope.repo}" (team "${scope.team}")` : `repo "${scope.repo}"`;
}

const SEVERITY: Record<ReadinessCheck["status"], number> = { ok: 0, action: 1, warn: 2, fail: 3 };

/**
 * Default harness check: resolve the `AGENT_HARNESS` chain like the worker does.
 *
 * @param env - The worker's environment (process env plus the workspace `.env`).
 * @param scopes - Per-repository spawn environments ({@link harnessEnvScopes});
 *   defaults to `env` alone.
 */
export async function defaultCheckHarness(
  env: Env,
  scopes: HarnessEnvScope[] = [{ env, layers: [{ source: PROCESS_ENV_SOURCE, values: env }] }],
): Promise<ReadinessCheck> {
  const label = "Agent harness";
  try {
    // One at a time: each evaluation overlays process.env until it finishes.
    const worker = await selectWorkerEntries(env, env.AGENT_HARNESS);
    const verdicts: ScopeVerdict[] = [];
    const scopeLabels: (string | undefined)[] = [];
    if (worker.verdict) {
      verdicts.push(worker.verdict);
      scopeLabels.push(undefined);
    }
    for (const scope of scopes) {
      verdicts.push(await evaluateScope(scope, worker.selected));
      scopeLabels.push(scopeLabel(scope));
    }
    const worst = Math.max(...verdicts.map((verdict) => SEVERITY[verdict.status]));
    const status = verdicts.find((verdict) => SEVERITY[verdict.status] === worst)?.status ?? "ok";
    const shown = verdicts
      .map((verdict, index) => ({ verdict, label: scopeLabels[index] }))
      .filter(({ verdict }) => SEVERITY[verdict.status] === worst);
    const details = [...new Set(shown.map(({ verdict }) => verdict.detail))];
    // The same message for every repo: show it once, unprefixed.
    const detail =
      details.length === 1 && shown.length === verdicts.length
        ? details[0]
        : shown
            .map(({ verdict, label }) => (label ? `${label}: ${verdict.detail}` : verdict.detail))
            .join("; ");
    const hint = shown[0]?.verdict.hint;
    return {
      id: "harness",
      label,
      status,
      ...(detail ? { detail } : {}),
      ...(hint ? { hint } : {}),
    };
  } catch (error) {
    return {
      id: "harness",
      label,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      hint: "Set AGENT_HARNESS in the workspace .env to a registered harness",
    };
  }
}
