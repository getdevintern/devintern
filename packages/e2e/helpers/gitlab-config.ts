import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitLab } from "../providers/gitlab";

export const gitlabCredentialsPath = resolve(import.meta.dir, "../.local/gitlab.json");

export function resolveGitLabConfig(
  env: Record<string, string | undefined> = process.env,
  readLocal: () => { baseUrl: string; token: string } = () => {
    if (!existsSync(gitlabCredentialsPath)) {
      throw new Error("Start local GitLab first: bun run --filter @devintern/e2e gitlab:up");
    }
    return JSON.parse(readFileSync(gitlabCredentialsPath, "utf8"));
  },
): { baseUrl: string; token: string } {
  const hasUrl = Boolean(env.E2E_GITLAB_URL?.trim());
  const hasToken = Boolean(env.E2E_GITLAB_TOKEN?.trim());
  if (hasUrl !== hasToken) throw new Error("Set both E2E_GITLAB_URL and E2E_GITLAB_TOKEN");
  const ci =
    Boolean(env.CI && env.CI !== "0" && env.CI !== "false") || env.GITHUB_ACTIONS === "true";
  if (ci && !hasUrl) throw new Error("CI requires E2E_GITLAB_URL and E2E_GITLAB_TOKEN");
  const config = hasUrl
    ? { baseUrl: env.E2E_GITLAB_URL!.trim(), token: env.E2E_GITLAB_TOKEN!.trim() }
    : readLocal();
  if (!config.token?.trim()) throw new Error("GitLab E2E token is empty; rerun gitlab:up");
  return { baseUrl: new GitLab(config.baseUrl, config.token).baseUrl, token: config.token.trim() };
}
