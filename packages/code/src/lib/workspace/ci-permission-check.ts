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
import { gitHubSlugFromRemote } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { buildRepoCredentialEnv, parseEnvFile } from "./env";
import { workspaceEnvPath } from "./paths";

type Env = Record<string, string | undefined>;

/**
 * GitHub slug of a repository whose worker runs read commit CI state
 * (auto-merge or automatic CI fixes on), else `undefined`.
 */
export function ciPermissionProbeSlug(
  config: WorkspaceConfig,
  repo: RepoConfig,
): string | undefined {
  if (repo.manualOnly) return undefined;
  if (!config.workspace.autoMerge.enabled && !config.workspace.ciFailureFix) return undefined;
  return gitHubSlugFromRemote(repo.remote) ?? undefined;
}

/** Where a repository's `GITHUB_TOKEN` comes from, by layer name or file path (never the value). */
export function gitHubTokenSource(repo: RepoConfig, workspaceDir: string): string {
  if (repo.env.GITHUB_TOKEN) return `GITHUB_TOKEN in [[repos]] "${repo.name}" env, workspace.toml`;
  if (repo.envFile) {
    const path = isAbsolute(repo.envFile) ? repo.envFile : join(workspaceDir, repo.envFile);
    if (parseEnvFile(path).GITHUB_TOKEN) return `GITHUB_TOKEN in ${path}`;
  }
  const workspaceEnv = workspaceEnvPath(workspaceDir);
  if (parseEnvFile(workspaceEnv).GITHUB_TOKEN) return `GITHUB_TOKEN in ${workspaceEnv}`;
  return "GITHUB_TOKEN in the worker's environment";
}

/**
 * The credential the repository's GitHub API calls use: `GITHUB_TOKEN` for
 * relay-hosted workspaces (`token-only`), else a customer-owned GitHub App
 * when one is configured (`app-first`), else `GITHUB_TOKEN`.
 */
export function resolveCiProbeCredential(input: {
  repo: RepoConfig;
  slug: string;
  env: Env;
  workspaceDir: string;
  usesHostedApp: boolean;
}): CiProbeCredential | undefined {
  const { repo, slug, env, workspaceDir, usesHostedApp } = input;
  if (!usesHostedApp) {
    const app = GitHubAppAuth.fromEnvironment(env);
    if (app) {
      const [owner = "", name = ""] = slug.split("/");
      return { kind: "app", getToken: () => app.getTokenForRepository(owner, name) };
    }
  }
  const token = env.GITHUB_TOKEN;
  if (!token) return undefined;
  return { kind: "token", token, source: gitHubTokenSource(repo, workspaceDir) };
}

/** Outcome for one repository: probed, or skipped because no credential is configured. */
export type RepoCiPermissionOutcome =
  | { kind: "probed"; slug: string; credential: CiProbeCredential["kind"]; result: CiProbeResult }
  | { kind: "no-credential"; slug: string };

/**
 * Probe one repository with the credential its runs use (the same env layers
 * as the doctor's repository-access check). Never throws.
 */
export async function probeRepoCiPermissions(input: {
  repo: RepoConfig;
  slug: string;
  ciFailureFix: boolean;
  workspaceDir: string;
  processEnv: Env;
  usesHostedApp: boolean;
  fetch?: CiProbeFetch;
  timeoutMs?: number;
}): Promise<RepoCiPermissionOutcome> {
  const env: Env = {
    ...input.processEnv,
    ...buildRepoCredentialEnv(input.repo, input.workspaceDir),
  };
  const credential = resolveCiProbeCredential({ ...input, env });
  if (!credential) return { kind: "no-credential", slug: input.slug };
  const result = await probeGitHubCiPermissions({
    slug: input.slug,
    credential,
    ciFailureFix: input.ciFailureFix,
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
  options: { processEnv?: Env; usesHostedApp?: boolean; fetch?: CiProbeFetch } = {},
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
          repo,
          slug,
          ciFailureFix: config.workspace.ciFailureFix,
          workspaceDir,
          processEnv: options.processEnv ?? process.env,
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
