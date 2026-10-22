import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";
import { resolveGitHubConfig } from "../helpers/github-config";
import { resolveGitLabComConfig } from "../helpers/hosted-config";

// Resolve both sides before spawning: the GitLab.com project hosts the issues,
// and GitHub publishes the pull request. A missing value fails fast and never
// reaches a remote service.
const gitlab = resolveGitLabComConfig();
const github = await resolveGitHubConfig();
if (!existsSync(cliPath))
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");

const child = Bun.spawn(
  [process.execPath, "test", "./tests/code/gitlab-com-tracker.test.ts", "--timeout", "240000"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      E2E_GITLAB_COM_PROJECT: gitlab.projectPath,
      E2E_GITLAB_COM_TOKEN: gitlab.token,
      E2E_GITHUB_REPOSITORY: github.repository,
      E2E_GITHUB_TOKEN: github.token,
      DEVINTERN_E2E_GITLAB_COM_TRACKER: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
