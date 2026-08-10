/**
 * Detect a GitHub `owner/repo` slug from a checkout's `origin` remote URL.
 */

import { parseGitHubRepoInput } from "../shared/github-repo.ts";
import type { GitExec } from "./git-sync.ts";

/** Return canonical slug for origin when it points at GitHub, else null. */
export async function detectGitHubRemoteSlug(
  projectDir: string,
  gitExec: GitExec,
): Promise<string | null> {
  const result = await gitExec(projectDir, ["remote", "get-url", "origin"]);
  if (result.code !== 0) return null;
  const url = result.stdout.trim();
  if (!url) return null;
  return parseGitHubRepoInput(url)?.slug ?? null;
}
