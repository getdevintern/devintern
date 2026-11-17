import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveGitLabConfig } from "../helpers/gitlab-config";
import { cliPath } from "../helpers/fixture-workspace";

if (!existsSync(cliPath))
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
const config = resolveGitLabConfig();
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "./tests/code/gitlab.test.ts",
    "./tests/code/gitlab-lifecycle.test.ts",
    "./tests/code/gitlab-worker.test.ts",
    "--timeout",
    "240000",
  ],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      E2E_GITLAB_URL: config.baseUrl,
      E2E_GITLAB_TOKEN: config.token,
      DEVINTERN_E2E_GITLAB: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
