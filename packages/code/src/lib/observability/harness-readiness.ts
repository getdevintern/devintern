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
 *   subprocess resolves the executable from that env.
 *
 * A configured path that does not resolve is reported with its key, value,
 * and the file that set it.
 */

import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { resolveExecutablePath, resolveHarnessChainSync } from "@devintern/agent-harness";
import type { HarnessChainEntry } from "@devintern/agent-harness";
import type { RepoConfig } from "../workspace/config";
import { parseEnvFile } from "../workspace/env";
import { workspaceEnvPath } from "../workspace/paths";
import { withEnvOverlay } from "./readiness";
import type { ReadinessCheck } from "./readiness";

type Env = Record<string, string | undefined>;

/** One env layer with a human-readable origin (a file path or "the environment"). */
export interface HarnessEnvLayer {
  source: string;
  values: Env;
}

/** The composed env one agent spawn sees, with its layers in precedence order. */
export interface HarnessEnvScope {
  /** Repository the scope belongs to; absent for the workspace-level scope. */
  repo?: string;
  env: Env;
  /** Layers in precedence order (later wins), for naming where a value came from. */
  layers: HarnessEnvLayer[];
}

const PROCESS_ENV_SOURCE = "the environment";

/**
 * Harness scopes for a workspace: one per repository the worker serves, or
 * a single workspace-level scope when no repository is configured.
 *
 * @param processEnv - The worker's environment before the workspace `.env` applies.
 * @param workspaceDir - Workspace home holding `.env` and `workspace.toml`.
 * @param repos - Repositories the worker routes tasks to.
 */
export function harnessEnvScopes(
  processEnv: Env,
  workspaceDir: string,
  repos: readonly RepoConfig[] = [],
): HarnessEnvScope[] {
  const workspacePath = workspaceEnvPath(workspaceDir);
  const base: HarnessEnvLayer[] = [
    { source: PROCESS_ENV_SOURCE, values: processEnv },
    { source: workspacePath, values: parseEnvFile(workspacePath) },
  ];
  if (repos.length === 0) return [scopeFromLayers(base)];
  return repos.map((repo) => {
    const layers = [...base];
    if (repo.envFile) {
      const path = isAbsolute(repo.envFile) ? repo.envFile : join(workspaceDir, repo.envFile);
      layers.push({ source: path, values: parseEnvFile(path) });
    }
    if (Object.keys(repo.env).length > 0) {
      layers.push({
        source: `[repos.env] of "${repo.name}" in ${join(workspaceDir, "workspace.toml")}`,
        values: repo.env,
      });
    }
    return scopeFromLayers(layers, repo.name);
  });
}

function scopeFromLayers(layers: HarnessEnvLayer[], repo?: string): HarnessEnvScope {
  const env: Env = {};
  for (const layer of layers) Object.assign(env, layer.values);
  return { ...(repo ? { repo } : {}), env, layers };
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

/** A configured (not default) path that does not resolve, with where it was set. */
function configuredPathProblem(
  entry: HarnessChainEntry,
  scope: HarnessEnvScope,
): ScopeVerdict | undefined {
  const key = cliPathKeys(entry.name).find((candidate) => scope.env[candidate] === entry.path);
  if (!key) return undefined;
  const source =
    [...scope.layers].reverse().find((layer) => layer.values[key] === entry.path)?.source ??
    PROCESS_ENV_SOURCE;
  const bare = !entry.path.includes("/") && !entry.path.includes("\\");
  const problem = bare
    ? "is not on PATH"
    : existsSync(resolveExecutablePath(entry.path))
      ? "is not executable"
      : "does not exist";
  const where = source === PROCESS_ENV_SOURCE ? "in the environment" : `in ${source}`;
  return {
    status: "fail",
    detail: `${entry.name}: ${key}=${entry.path} (set ${where}) ${problem}`,
    hint: `Point ${key} ${where} at the agent CLI executable, or remove it to use the CLI on PATH`,
  };
}

async function evaluateScope(
  scope: HarnessEnvScope,
  rawHarness: string | undefined,
): Promise<ScopeVerdict> {
  const chain = await withEnvOverlay(overlayFor(scope, rawHarness), async () =>
    resolveHarnessChainSync({ raw: rawHarness, warnDeprecated: false }),
  );
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
  if (chain.issues.length > 0) {
    return {
      status: "warn",
      detail: chain.issues.map((issue) => issue.message).join(" "),
      hint: "Remove or install the skipped AGENT_HARNESS entries in the workspace .env",
    };
  }
  return { status: "ok", detail: names };
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
    const verdicts: ScopeVerdict[] = [];
    for (const scope of scopes) verdicts.push(await evaluateScope(scope, env.AGENT_HARNESS));
    const worst = Math.max(...verdicts.map((verdict) => SEVERITY[verdict.status]));
    const status = verdicts.find((verdict) => SEVERITY[verdict.status] === worst)?.status ?? "ok";
    const shown = verdicts
      .map((verdict, index) => ({ verdict, repo: scopes[index]?.repo }))
      .filter(({ verdict }) => SEVERITY[verdict.status] === worst);
    const details = [...new Set(shown.map(({ verdict }) => verdict.detail))];
    // The same message for every repo: show it once, unprefixed.
    const detail =
      details.length === 1 && shown.length === verdicts.length
        ? details[0]
        : shown
            .map(({ verdict, repo }) =>
              repo ? `repo "${repo}": ${verdict.detail}` : verdict.detail,
            )
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
