import { spawnSync } from "child_process";
import type { ArtifactUploader } from "../artifacts/types";
import {
  classifyGitHubToken,
  createGitHubAttachmentUploader,
  GITHUB_APP_INSTALLATION_UNSUPPORTED,
} from "./github/attachment-uploader";
import { createGitLabUploadAdapter } from "./gitlab/upload-adapter";
import { parseGitLabHostAliases, parseGitRemoteUrl } from "./provider";
import { resolveGitLabCodeHostConfig } from "./shared";

export const NATIVE_ARTIFACT_UPLOADERS = ["github", "gitlab", "code-host"] as const;
export type NativeArtifactUploaderName = (typeof NATIVE_ARTIFACT_UPLOADERS)[number];

export function isNativeArtifactUploader(value: string): value is NativeArtifactUploaderName {
  return (NATIVE_ARTIFACT_UPLOADERS as readonly string[]).includes(value);
}

/** Adapter that reports why native hosting is unavailable; each upload records it. */
function unavailable(message: string): ArtifactUploader {
  return {
    upload: () => Promise.reject(new Error(message)),
  };
}

function originRemoteUrl(cwd: string): string {
  return (
    spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).stdout?.trim() ??
    ""
  );
}

/**
 * Resolve a native code-host uploader for the checkout's origin remote using
 * the same credentials as PR/MR creation (never another uploader backend).
 * For GitLab that includes resolveGitLabCodeHostConfig's documented fallback
 * to the tracker GITLAB_TOKEN when TASK_TRACKER=gitlab targets the same instance.
 * Unsupported setups yield an adapter whose uploads fail with an actionable
 * status, so publication stays advisory instead of failing the run.
 *
 * The returned id scopes cached upload URLs to provider + instance + project.
 */
export function loadNativeArtifactUploader(
  name: NativeArtifactUploaderName,
  options: { cwd?: string; remoteUrl?: string; env?: NodeJS.ProcessEnv } = {},
): { id: string; adapter: ArtifactUploader } {
  const env = options.env ?? process.env;
  const remoteUrl = options.remoteUrl ?? originRemoteUrl(options.cwd ?? process.cwd());
  const repository = parseGitRemoteUrl(remoteUrl, {
    gitlabBaseUrl: env.GITLAB_CODE_HOST_URL,
    gitlabHostAliases: parseGitLabHostAliases(env.GITLAB_CODE_HOST_ALIASES),
  });
  const provider = name === "code-host" ? repository?.provider : name;

  if (!repository || repository.provider !== provider) {
    const detected = repository
      ? `${repository.provider} (${repository.instanceUrl})`
      : "an unrecognized host";
    const hint =
      provider === "github"
        ? " Native GitHub attachments support github.com only; GitHub Enterprise Server is not supported."
        : provider === "gitlab"
          ? " For Self-Managed GitLab set GITLAB_CODE_HOST_URL (and GITLAB_CODE_HOST_ALIASES for SSH hosts)."
          : "";
    return {
      id: `native-${name}:unresolved`,
      adapter: unavailable(
        `The ${name} artifact uploader needs a ${provider ?? "GitHub or GitLab"} origin remote, but origin points to ${detected}.${hint}`,
      ),
    };
  }

  const scope = `${repository.instanceUrl}/${repository.projectPath}`.toLowerCase();
  if (repository.provider === "github") {
    const id = `native-github:${scope}`;
    const token = env.GITHUB_TOKEN?.trim();
    if (!token)
      return {
        id,
        adapter: unavailable(
          env.GITHUB_APP_ID
            ? GITHUB_APP_INSTALLATION_UNSUPPORTED
            : "Set GITHUB_TOKEN (OAuth or personal access token with write access) for native GitHub attachments",
        ),
      };
    if (classifyGitHubToken(token) === "app-installation")
      return { id, adapter: unavailable(GITHUB_APP_INSTALLATION_UNSUPPORTED) };
    return {
      id,
      adapter: createGitHubAttachmentUploader({ token, repository: repository.projectPath }),
    };
  }

  if (repository.provider === "gitlab") {
    const id = `native-gitlab:${scope}`;
    const config = resolveGitLabCodeHostConfig(repository.instanceUrl, env);
    if (!config.ok) return { id, adapter: unavailable(config.message) };
    try {
      return {
        id,
        adapter: createGitLabUploadAdapter({
          token: config.token,
          instanceUrl: config.instanceUrl,
          caFile: config.caFile,
          proxy: config.proxy,
          projectPath: repository.projectPath,
        }),
      };
    } catch (error) {
      // GitLabApi reads GITLAB_CODE_HOST_CA_FILE eagerly; keep a bad path advisory.
      const reason = error instanceof Error ? error.message : String(error);
      return {
        id,
        adapter: unavailable(`Cannot read GITLAB_CODE_HOST_CA_FILE: ${reason}`),
      };
    }
  }

  return {
    id: `native-${repository.provider}:${scope}`,
    adapter: unavailable(`Native artifact uploads are not supported for ${repository.provider}`),
  };
}
