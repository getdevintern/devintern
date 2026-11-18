import { Utils } from "../../utils";
import type { ArtifactUploader, RunArtifact } from "../../artifacts/types";

const MB = 1024 * 1024;

/**
 * Media accepted by GitHub's native attachment flow and its per-type limits
 * (images/videos 10 MB, other attachments 25 MB). Anything else is rejected
 * before upload so the status names the real problem.
 */
const GITHUB_ATTACHMENT_LIMITS: Record<string, number> = {
  "image/png": 10 * MB,
  "image/gif": 10 * MB,
  "image/jpeg": 10 * MB,
  "image/svg+xml": 10 * MB,
  "video/mp4": 10 * MB,
  "video/quicktime": 10 * MB,
  "video/webm": 10 * MB,
  "text/plain": 25 * MB,
  "text/markdown": 25 * MB,
  "text/csv": 25 * MB,
  "text/x-log": 25 * MB,
  "text/x-diff": 25 * MB,
  "text/x-patch": 25 * MB,
  "application/json": 25 * MB,
  "application/pdf": 25 * MB,
  "application/zip": 25 * MB,
  "application/gzip": 25 * MB,
};

export type GitHubTokenKind =
  | "oauth"
  | "personal-classic"
  | "personal-fine-grained"
  | "app-user"
  | "app-installation"
  | "unknown";

/** Classify a GitHub credential by its documented prefix; never sent anywhere. */
export function classifyGitHubToken(token: string): GitHubTokenKind {
  if (token.startsWith("gho_")) return "oauth";
  if (token.startsWith("ghp_")) return "personal-classic";
  if (token.startsWith("github_pat_")) return "personal-fine-grained";
  // App user-to-server tokens act as the user, unlike installation tokens.
  if (token.startsWith("ghu_")) return "app-user";
  if (token.startsWith("ghs_")) return "app-installation";
  return "unknown";
}

export const GITHUB_APP_INSTALLATION_UNSUPPORTED =
  "GitHub App installation tokens cannot upload native attachments (the official GitHub CLI uploader excludes them). Set GITHUB_TOKEN to an OAuth or personal access token with write access, or use the files-sdk or a custom uploader.";

export interface GitHubAttachmentUploaderOptions {
  token: string;
  /** `owner/repo` on github.com. */
  repository: string;
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
}

/**
 * Native github.com user-attachment uploads, mirroring the official GitHub CLI
 * flow: POST raw bytes to uploads.github.com/user-attachments/assets with the
 * destination repository ID. Never creates comments, commits, or branches.
 */
export function createGitHubAttachmentUploader(
  options: GitHubAttachmentUploaderOptions,
): ArtifactUploader {
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const uploadBaseUrl = (options.uploadBaseUrl ?? "https://uploads.github.com").replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "devintern",
  };
  let repositoryId: Promise<number> | undefined;

  const resolveRepositoryId = async (): Promise<number> => {
    if (classifyGitHubToken(options.token) === "app-installation")
      throw new Error(GITHUB_APP_INSTALLATION_UNSUPPORTED);
    const response = await Utils.fetchWithRetry(`${apiBaseUrl}/repos/${options.repository}`, {
      headers,
    });
    if (response.status === 401) throw new Error("GitHub rejected GITHUB_TOKEN (401)");
    if (response.status === 403 || response.status === 404)
      throw new Error(
        `GitHub repository ${options.repository} is not accessible with GITHUB_TOKEN (${response.status})`,
      );
    if (!response.ok) throw new Error(`GitHub repository lookup failed (${response.status})`);
    const repo = (await response.json()) as {
      id?: number;
      permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
    };
    if (!Number.isSafeInteger(repo.id) || repo.id! <= 0)
      throw new Error("GitHub did not return a repository ID");
    const permissions = repo.permissions;
    if (permissions && !permissions.admin && !permissions.maintain && !permissions.push)
      throw new Error(
        `Native GitHub attachments require write access to ${options.repository}; GITHUB_TOKEN has read-only access`,
      );
    return repo.id!;
  };

  return {
    async upload(artifact: RunArtifact, bytes: Uint8Array) {
      const mediaType = artifact.mediaType.split(";")[0]!.trim().toLowerCase();
      const limit = GITHUB_ATTACHMENT_LIMITS[mediaType];
      if (!limit)
        throw new Error(
          `GitHub attachments do not accept ${artifact.mediaType}; use PNG, GIF, JPEG, SVG, a supported video, or a text/PDF/ZIP file`,
        );
      if (bytes.byteLength > limit)
        throw new Error(
          `${artifact.name} is ${(bytes.byteLength / MB).toFixed(1)} MB; GitHub allows ${limit / MB} MB for ${mediaType}`,
        );
      // Reset after a failed lookup so a later publication can retry it.
      repositoryId ??= resolveRepositoryId().catch((error: unknown) => {
        repositoryId = undefined;
        throw error;
      });
      const id = await repositoryId;
      const params = new URLSearchParams({
        name: artifact.name,
        content_type: mediaType,
        repository_id: String(id),
      });
      const response = await Utils.fetchWithRetry(
        `${uploadBaseUrl}/user-attachments/assets?${params}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/octet-stream" },
          body: bytes,
        },
        { maxRetries: 0 },
      );
      if (!response.ok) {
        // The endpoint answers 404 rather than 403 when the token cannot write.
        if (response.status === 404 || response.status === 403)
          throw new Error(
            `Native GitHub attachments require write access to ${options.repository} (${response.status})`,
          );
        if (response.status === 422) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(
            `GitHub rejected the attachment: ${(body?.message ?? "validation failed").replace(/\s*\n\s*/g, "; ")}`,
          );
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          throw new Error(
            `GitHub attachment upload was rate limited${retryAfter && /^\d+$/.test(retryAfter) ? `; retry after ${retryAfter} seconds` : ""}`,
          );
        }
        throw new Error(`GitHub attachment upload failed (${response.status})`);
      }
      const { url } = (await response.json()) as { url?: string };
      if (!url) throw new Error("GitHub returned no attachment URL");
      return { url };
    },
  };
}
