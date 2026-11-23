import type { ArtifactUploader, RunArtifact } from "../../artifacts/types";
import { GitLabApi, gitLabErrorMessage } from "./api";
import type { GitLabApiOptions } from "./api";

interface GitLabUploadProject {
  id: number;
  path_with_namespace: string;
  visibility?: "public" | "internal" | "private";
  /** "Require authentication to view media files" (GitLab 16.x+; absent on older versions). */
  enforce_auth_checks_on_uploads?: boolean;
}

interface GitLabUploadResponse {
  id?: number;
  url?: string;
  full_path?: string;
}

/** Describe who can open uploaded files; settings are reported, never changed. */
export function gitLabMediaAccessNotice(project: GitLabUploadProject): string {
  if (project.visibility === "public") return "Public project: uploads are publicly viewable.";
  const scope = project.visibility
    ? `${project.visibility[0]!.toUpperCase()}${project.visibility.slice(1)} project`
    : "Project";
  if (project.enforce_auth_checks_on_uploads === true)
    return `${scope}: "Require authentication to view media files" is on, so reviewers must be signed in with project access.`;
  if (project.enforce_auth_checks_on_uploads === false)
    return `${scope}: uploads are viewable by anyone with the link ("Require authentication to view media files" is off).`;
  return `${scope}: uploads are viewable by anyone with the link unless "Require authentication to view media files" is enabled (setting not reported by this GitLab).`;
}

/** Non-public project whose uploads are not known to require sign-in. */
export function isGitLabUploadLinkPublic(project: GitLabUploadProject): boolean {
  return project.visibility !== "public" && project.enforce_auth_checks_on_uploads !== true;
}

/**
 * Turn a GitLab upload reference into an absolute URL without losing the
 * instance's relative installation path. `full_path` is either
 * `/-/project/:id/uploads/...` (GitLab 17+) or `/:namespace/:project/uploads/...`,
 * and may or may not already include the relative URL root.
 */
export function normalizeGitLabUploadUrl(
  instanceUrl: string,
  projectPath: string,
  upload: GitLabUploadResponse,
): string {
  const base = new URL(`${instanceUrl.replace(/\/+$/, "")}/`);
  const prefix = base.pathname.replace(/\/+$/, "");
  const reference = upload.full_path ?? (upload.url ? `/${projectPath}${upload.url}` : undefined);
  if (!reference) throw new Error("GitLab returned no upload URL");
  if (/^https?:\/\//i.test(reference)) {
    const absolute = new URL(reference);
    if (absolute.origin !== base.origin)
      throw new Error("GitLab returned an upload URL on a different host");
    return absolute.href;
  }
  if (!reference.startsWith("/")) throw new Error("GitLab returned an unexpected upload URL");
  const alreadyPrefixed =
    prefix &&
    (reference.startsWith(`${prefix}/-/`) ||
      reference.startsWith(`${prefix}/${projectPath}/uploads/`));
  return new URL(`${alreadyPrefixed ? "" : prefix}${reference}`, base.origin).href;
}

export interface GitLabUploadAdapterOptions extends GitLabApiOptions {
  /** `group/subgroup/project` on the configured instance. */
  projectPath: string;
}

/** Native `POST /projects/:id/uploads` adapter for GitLab.com and Self-Managed. */
export function createGitLabUploadAdapter(options: GitLabUploadAdapterOptions): ArtifactUploader {
  const api = new GitLabApi(options);
  let project: Promise<GitLabUploadProject> | undefined;
  const resolveProject = async () => {
    const response = await api.request(`/projects/${encodeURIComponent(options.projectPath)}`);
    if (response.status === 401) throw new Error("GitLab rejected the code-host token (401)");
    if (!response.ok)
      throw new Error(
        `GitLab project ${options.projectPath} lookup failed: ${await gitLabErrorMessage(response)}`,
      );
    return (await response.json()) as GitLabUploadProject;
  };

  return {
    async upload(artifact: RunArtifact, bytes: Uint8Array) {
      project ??= resolveProject().catch((error: unknown) => {
        project = undefined;
        throw error;
      });
      const resolved = await project;
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: artifact.mediaType }), artifact.name);
      const response = await api.request(
        `/projects/${resolved.id}/uploads`,
        { method: "POST", body: form },
        { maxRetries: 0 },
      );
      if (!response.ok) {
        if (response.status === 413)
          throw new Error(
            `${artifact.name} exceeds this GitLab instance's maximum attachment size (413)`,
          );
        if (response.status === 403 || response.status === 404)
          throw new Error(
            `The GitLab code-host token cannot upload files to ${resolved.path_with_namespace} (${response.status})`,
          );
        throw new Error(`GitLab upload failed: ${await gitLabErrorMessage(response)}`);
      }
      const upload = (await response.json()) as GitLabUploadResponse;
      return {
        url: normalizeGitLabUploadUrl(api.instanceUrl, resolved.path_with_namespace, upload),
        ...(upload.id ? { remoteId: `gitlab-upload:${resolved.id}:${upload.id}` } : {}),
        notice: gitLabMediaAccessNotice(resolved),
        linkPublic: isGitLabUploadLinkPublic(resolved),
      };
    },
  };
}
