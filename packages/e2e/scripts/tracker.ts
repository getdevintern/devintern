import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";
import { resolveGitHubTrackerConfig } from "../helpers/tracker-config";

// Resolve and validate tracker configuration before spawning the suite, so a
// missing variable fails fast and never reaches a remote tracker.
const config = resolveGitHubTrackerConfig();
if (!existsSync(cliPath)) {
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
}

const child = Bun.spawn(
  [process.execPath, "test", "./tests/code/github-tracker.test.ts", "--timeout", "240000"],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      E2E_TRACKER_REPOSITORY: config.repository,
      E2E_TRACKER_TOKEN: config.token,
      E2E_TRACKER_STATUS_LABELS: config.statusLabels.join(","),
      DEVINTERN_E2E_GITHUB_TRACKER: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
