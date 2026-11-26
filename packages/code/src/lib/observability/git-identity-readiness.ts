/**
 * "Git commit identity" readiness row for `worker doctor` and
 * `worker init --non-interactive`: which identity the worker's commits will
 * carry on this host, and how to set one when only the fallback is left.
 * Resolution itself lives in `utils/git-identity.ts`.
 */

import type { RepoConfig, WorkspaceConfig } from "../workspace/config";
import { buildRepoCredentialEnv } from "../workspace/env";
import {
  COMMIT_IDENTITY_FIX,
  GIT_AUTHOR_EMAIL_ENV,
  GIT_AUTHOR_NAME_ENV,
  describeCommitIdentity,
  isIdentityComplete,
  readConfiguredIdentity,
  resolveCommitIdentity,
} from "../utils/git-identity";
import type { CommitIdentity, IdentityDeps } from "../utils/git-identity";
import type { ReadinessCheck } from "./readiness";

type Env = Record<string, string | undefined>;

export interface GitIdentityCheckInput {
  config?: WorkspaceConfig;
  workspaceDir: string;
  processEnv: Env;
  offline: boolean;
  deps?: IdentityDeps;
}

const BASE = { id: "git-identity", label: "Git commit identity" } as const;

/** Environment one repo's task commits resolve their identity from. */
function repoIdentityEnv(repo: RepoConfig, input: GitIdentityCheckInput): Env {
  return {
    ...input.processEnv,
    ...buildRepoCredentialEnv(repo, input.workspaceDir),
    ...(repo.gitAuthor
      ? { [GIT_AUTHOR_NAME_ENV]: repo.gitAuthor.name, [GIT_AUTHOR_EMAIL_ENV]: repo.gitAuthor.email }
      : {}),
  };
}

/**
 * The readiness row. `ok` when git is configured on the host or an identity
 * resolves from the workspace setting or a token's user; `warn` when commits
 * would fall back to the generic DevIntern identity. Never throws.
 */
export async function gitCommitIdentityCheck(
  input: GitIdentityCheckInput,
): Promise<ReadinessCheck> {
  try {
    return await identityCheck(input);
  } catch (error) {
    return {
      ...BASE,
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      hint: `Could not resolve the commit identity. ${COMMIT_IDENTITY_FIX}`,
    };
  }
}

async function identityCheck(input: GitIdentityCheckInput): Promise<ReadinessCheck> {
  const configured = readConfiguredIdentity(input.workspaceDir, input.processEnv);
  if (isIdentityComplete(configured)) {
    return {
      ...BASE,
      status: "ok",
      detail: `${configured.authorName} <${configured.authorEmail}> (configured in git)`,
    };
  }

  const all = input.config?.repos ?? [];
  const worker = all.filter((repo) => !repo.manualOnly);
  const repos = worker.length > 0 ? worker : all;
  const resolved: { repo?: string; identity: CommitIdentity }[] = [];
  if (repos.length === 0) {
    resolved.push({
      identity: await resolveCommitIdentity(input.processEnv, {
        offline: input.offline,
        deps: { remoteUrl: () => undefined, ...input.deps },
      }),
    });
  }
  for (const repo of repos) {
    resolved.push({
      repo: repo.name,
      identity: await resolveCommitIdentity(repoIdentityEnv(repo, input), {
        offline: input.offline,
        deps: { remoteUrl: () => repo.remote || undefined, ...input.deps },
      }),
    });
  }

  const fallback = resolved.filter((entry) => entry.identity.source === "fallback");
  const descriptions = new Set(resolved.map((entry) => describeCommitIdentity(entry.identity)));
  const detail =
    descriptions.size === 1
      ? [...descriptions][0]
      : `${descriptions.size} identities across ${resolved.length} repositories`;
  const items =
    descriptions.size > 1
      ? resolved.map((entry) => `${entry.repo}: ${describeCommitIdentity(entry.identity)}`)
      : undefined;
  if (fallback.length === 0) {
    return { ...BASE, status: "ok", detail, ...(items ? { items } : {}) };
  }
  const reason = fallback[0]?.identity.reason;
  return {
    ...BASE,
    status: "warn",
    detail: `${detail}${reason ? `: ${reason}` : ""}`,
    hint: `Commits will use the generic DevIntern identity. To commit under your own name, ${COMMIT_IDENTITY_FIX}`,
    ...(items ? { items } : {}),
  };
}
