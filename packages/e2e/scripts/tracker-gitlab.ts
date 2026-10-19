import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";
import { resolveGitHubConfig } from "../helpers/github-config";
import { resolveGitLabConfig } from "../helpers/gitlab-config";

// Resolve both sides before spawning: the local GitLab credentials are the
// tracker source, and the GitHub code host publishes the pull request. A
// missing value fails fast and never reaches a remote service.
const gitlab = resolveGitLabConfig();
const github = await resolveGitHubConfig();
if (!existsSync(cliPath)) {
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
}

const child = Bun.spawn(
  [process.execPath, "test", "./tests/code/gitlab-tracker.test.ts", "--timeout", "240000"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      E2E_GITLAB_URL: gitlab.baseUrl,
      E2E_GITLAB_TOKEN: gitlab.token,
      E2E_GITHUB_REPOSITORY: github.repository,
      E2E_GITHUB_TOKEN: github.token,
      DEVINTERN_E2E_GITLAB_TRACKER: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
