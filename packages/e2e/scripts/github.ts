import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveGitHubConfig } from "../helpers/github-config";

const config = await resolveGitHubConfig();
if (!existsSync(resolve(import.meta.dir, "../../code/dist/index.js"))) {
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
}
const child = Bun.spawn([process.execPath, "test", "./tests/code", "--timeout", "240000"], {
  cwd: resolve(import.meta.dir, ".."),
  env: {
    ...process.env,
    E2E_GITHUB_REPOSITORY: config.repository,
    E2E_GITHUB_TOKEN: config.token,
    DEVINTERN_E2E_GITHUB: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
