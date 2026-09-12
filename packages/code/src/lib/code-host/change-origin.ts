import { parseGitRemoteUrl, parseGitLabHostAliases } from "./index";
import type { ChangeRequestIdentity, GitRemoteParseOptions } from "./index";
import { Utils } from "../utils";

/** Check the instance as well as the full namespace before operating on a checkout. */
export function assertGitLabOrigin(
  identity: ChangeRequestIdentity,
  remoteUrl: string | null,
  options: GitRemoteParseOptions,
): void {
  const remote = remoteUrl === null ? null : parseGitRemoteUrl(remoteUrl.trim(), options);
  if (
    remote?.provider !== "gitlab" ||
    remote.instanceUrl !== identity.instanceUrl ||
    remote.projectPath !== identity.projectPath
  ) {
    throw new Error(
      `The current origin does not match GitLab project ${identity.projectPath} on ${identity.instanceUrl}.`,
    );
  }
}

/** Resolve origin at the workflow's guard point using the current code-host profile. */
export async function assertCurrentGitLabOrigin(
  identity: ChangeRequestIdentity,
  options: { cwd?: string; verbose?: boolean } = {},
): Promise<void> {
  const result = await Utils.executeGitCommand(["remote", "get-url", "origin"], options);
  assertGitLabOrigin(identity, result.success ? result.output : null, {
    gitlabBaseUrl: process.env.GITLAB_CODE_HOST_URL,
    gitlabHostAliases: parseGitLabHostAliases(process.env.GITLAB_CODE_HOST_ALIASES),
  });
}
