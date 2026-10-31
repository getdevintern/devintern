import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveGitLabConfig } from "../helpers/gitlab-config";
import { resolveRelayE2EConfig } from "../helpers/relay-config";
import { cliPath } from "../helpers/fixture-workspace";

if (!existsSync(cliPath))
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
const gitlab = resolveGitLabConfig();
const relay = resolveRelayE2EConfig();
const child = Bun.spawn(
  [process.execPath, "test", "./tests/code/gitlab-relay.test.ts", "--timeout", "240000"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      E2E_GITLAB_URL: gitlab.baseUrl,
      E2E_GITLAB_TOKEN: gitlab.token,
      E2E_RELAY_URL: relay.relayUrl,
      E2E_RELAY_AUTH_SESSION: relay.sessionPath,
      DEVINTERN_E2E_GITLAB: "1",
      DEVINTERN_E2E_GITLAB_RELAY: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
