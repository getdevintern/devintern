import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";
import { resolveBitbucketConfig, resolveGitLabComConfig } from "../helpers/hosted-config";

const provider = process.argv[2];
let providerEnv: Record<string, string>;
if (provider === "bitbucket") {
  const config = resolveBitbucketConfig();
  providerEnv = {
    E2E_BITBUCKET_REPOSITORY: config.repository,
    E2E_BITBUCKET_TOKEN: config.token,
    DEVINTERN_E2E_BITBUCKET: "1",
  };
} else if (provider === "gitlab-com") {
  const config = resolveGitLabComConfig();
  providerEnv = {
    E2E_GITLAB_COM_PROJECT: config.projectPath,
    E2E_GITLAB_COM_TOKEN: config.token,
    DEVINTERN_E2E_GITLAB_COM: "1",
  };
} else {
  throw new Error("Usage: bun run scripts/hosted.ts bitbucket|gitlab-com");
}
if (!existsSync(cliPath))
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
const child = Bun.spawn(
  [process.execPath, "test", `./tests/code/${provider}.test.ts`, "--timeout", "240000"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ...providerEnv },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
