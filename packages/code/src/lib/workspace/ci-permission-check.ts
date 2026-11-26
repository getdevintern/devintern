/**
 * Workspace wiring for the GitHub CI-permission probe
 * (`code-host/github/ci-permission-probe.ts`), shared by `worker doctor` and
 * worker startup: which repositories need it, and which credential their
 * runs actually use.
 */

import { isAbsolute, join } from "path";
import { GitHubAppAuth } from "../code-host/github/app-auth";
import { probeGitHubCiPermissions } from "../code-host/github/ci-permission-probe";
import type {
  CiProbeCredential,
  CiProbeFetch,
  CiProbeResult,
} from "../code-host/github/ci-permission-probe";
import { resolveFleetEventTeam } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { namespacedTeamEnv, parseEnvFile, repoGitHubSlug } from "./env";
import { workspaceEnvPath } from "./paths";

/**
 * GitHub slug of a repository whose worker runs read commit CI state
 * (auto-merge or automatic CI fixes on), else `undefined`. Resolved like the
 * fleet's GitHub clients: `GITHUB_REPO` in the repo env, else the remote.
 */
export function ciPermissionProbeSlug(
  config: WorkspaceConfig,
  repo: RepoConfig,
): string | undefined {
  if (repo.manualOnly) return undefined;
  if (!config.workspace.autoMerge.enabled && !config.workspace.ciFailureFix) return undefined;
  return repoGitHubSlug(repo);
}

/**
 * Where the fleet's `GITHUB_TOKEN` for a repository comes from, by layer name
 * or file path (never the value). Walks the {@link buildFleetEventEnv} layers
 * from highest precedence down: the fleet-event team's inline env, its
 * `env_file`, its namespaced workspace value, then the repo env, repo
 * `env_file`, workspace `.env`, and finally the worker's environment.
 */
export function gitHubTokenSource(
  config: WorkspaceConfig,
  repo: RepoConfig,
  workspaceDir: string,
): string {
  const resolvePath = (file: string) => (isAbsolute(file) ? file : join(workspaceDir, file));
  const workspaceEnvFile = workspaceEnvPath(workspaceDir);
  const workspaceEnv = parseEnvFile(workspaceEnvFile);
  const team = resolveFleetEventTeam(config, repo.name);
  if (team) {
    if (team.env.GITHUB_TOKEN)
      return `GITHUB_TOKEN in [[teams]] "${team.name}" env, workspace.toml`;
    if (team.envFile) {
      const path = resolvePath(team.envFile);
      if (parseEnvFile(path).GITHUB_TOKEN) return `GITHUB_TOKEN in ${path}`;
    }
    const namespaced = Object.keys(workspaceEnv).find(
      (key) => workspaceEnv[key] && namespacedTeamEnv({ [key]: "x" }, team).GITHUB_TOKEN,
    );
    if (namespaced) return `${namespaced} in ${workspaceEnvFile}`;
  }
  if (repo.env.GITHUB_TOKEN) return `GITHUB_TOKEN in [[repos]] "${repo.name}" env, workspace.toml`;
  if (repo.envFile) {
    const path = resolvePath(repo.envFile);
    if (parseEnvFile(path).GITHUB_TOKEN) return `GITHUB_TOKEN in ${path}`;
  }
  if (workspaceEnv.GITHUB_TOKEN) return `GITHUB_TOKEN in ${workspaceEnvFile}`;
  return "GITHUB_TOKEN in the worker's environment";
}

/**
 * The credential the fleet's GitHub client for this repository uses
 * (`createFleetGitHubClientResolver`): `GITHUB_TOKEN` for relay-hosted
 * workspaces (`token-only`); otherwise (`app-first`) a customer-owned GitHub
 * App when the worker's own environment configures one, as
 * `GitHubReviewsClient` reads it, else `GITHUB_TOKEN`. The token is
 * {@link fleetGitHubTokenForRepo}, so team, repo and workspace layers resolve
 * exactly as the fleet's CI reads do.
 */
export async function resolveCiProbeCredential(input: {
  config: WorkspaceConfig;
  repo: RepoConfig;
  slug: string;
  workspaceDir: string;
  usesHostedApp: boolean;
}): Promise<CiProbeCredential | undefined> {
  const { config, repo, slug, workspaceDir, usesHostedApp } = input;
  if (!usesHostedApp) {
    const app = GitHubAppAuth.fromEnvironment();
    if (app) {
      const [owner = "", name = ""] = slug.split("/");
      return { kind: "app", getToken: () => app.getTokenForRepository(owner, name) };
    }
  }
  const { fleetGitHubTokenForRepo } = await import("./fleet-event-acquirers");
  const token = fleetGitHubTokenForRepo(config, workspaceDir, slug);
  if (!token) return undefined;
  return { kind: "token", token, source: gitHubTokenSource(config, repo, workspaceDir) };
}

/** Outcome for one repository: probed, or skipped because no credential is configured. */
export type RepoCiPermissionOutcome =
  | { kind: "probed"; slug: string; credential: CiProbeCredential["kind"]; result: CiProbeResult }
  | { kind: "no-credential"; slug: string };

/**
 * Probe one repository with the credential the fleet's CI reads use
 * ({@link resolveCiProbeCredential}). Never throws.
 */
export async function probeRepoCiPermissions(input: {
  config: WorkspaceConfig;
  repo: RepoConfig;
  slug: string;
  workspaceDir: string;
  usesHostedApp: boolean;
  fetch?: CiProbeFetch;
  timeoutMs?: number;
}): Promise<RepoCiPermissionOutcome> {
  const credential = await resolveCiProbeCredential(input);
  if (!credential) return { kind: "no-credential", slug: input.slug };
  const result = await probeGitHubCiPermissions({
    slug: input.slug,
    credential,
    ciFailureFix: input.config.workspace.ciFailureFix,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  return { kind: "probed", slug: input.slug, credential: credential.kind, result };
}

/** Whether the workspace's GitHub events arrive through the hosted relay App (local state only). */
export async function workspaceUsesHostedGitHubApp(workspaceDir: string): Promise<boolean> {
  const { resolveFleetGitHubHosting } = await import("./fleet-event-acquirers");
  return (await resolveFleetGitHubHosting(workspaceDir)).usesHostedApp;
}

/** The first failing permission's fix, shortened for one startup log line. */
function startupFailLine(repoName: string, result: CiProbeResult): string | undefined {
  const failed = result.findings.find((finding) => finding.status === "fail");
  if (!failed) return undefined;
  return `⚠️  [fleet] ${repoName}: GitHub credential ${failed.detail}; auto-merge and CI fixes can't read CI. ${failed.hint ?? ""}`.trimEnd();
}

/**
 * Worker startup: probe CI-read permissions once per repository that needs
 * them and print one `console.warn` line per failing repository. Network
 * problems and the unfixable fine-grained `Checks` gap stay quiet here (the
 * doctor reports them). Never throws.
 */
export async function warnOnCiPermissionIssues(
  config: WorkspaceConfig,
  workspaceDir: string,
  options: { usesHostedApp?: boolean; fetch?: CiProbeFetch } = {},
): Promise<void> {
  const targets = config.repos.flatMap((repo) => {
    const slug = ciPermissionProbeSlug(config, repo);
    return slug ? [{ repo, slug }] : [];
  });
  if (targets.length === 0) return;
  try {
    const usesHostedApp =
      options.usesHostedApp ?? (await workspaceUsesHostedGitHubApp(workspaceDir));
    await Promise.all(
      targets.map(async ({ repo, slug }) => {
        const outcome = await probeRepoCiPermissions({
          config,
          repo,
          slug,
          workspaceDir,
          usesHostedApp,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        const line =
          outcome.kind === "probed" ? startupFailLine(repo.name, outcome.result) : undefined;
        if (line) console.warn(line);
      }),
    );
  } catch {
    // Best effort: `devintern worker doctor` reports what startup could not check.
  }
}
