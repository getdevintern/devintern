import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { fleetGitHubTokenForRepo } from "../src/lib/workspace/fleet-event-acquirers";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "fleet-github-token-"));
  mkdirSync(join(workspaceDir, "env"));
  writeFileSync(join(workspaceDir, ".env"), "GITHUB_TOKEN=workspace-token\n");
  writeFileSync(join(workspaceDir, "env", "personal.env"), "GITHUB_TOKEN=personal-token\n");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("GitHub event requests use the fixed GitHub team's token for its repo", () => {
  const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"
task_query = "status = 'To Do'"

[[teams]]
name = "personal-github"
tracker = "github"
task_query = "is:open"
repo = "personal"
env_file = "env/personal.env"

[[teams]]
name = "company-github"
tracker = "github"
task_query = "is:open"
repo = "company"

[[repos]]
name = "company"
remote = "https://github.com/acme/company"

[[repos]]
name = "personal"
remote = "git@github.com:user/personal.git"
`);

  expect(fleetGitHubTokenForRepo(config, workspaceDir, "acme/company")).toBe("workspace-token");
  expect(fleetGitHubTokenForRepo(config, workspaceDir, "user/personal")).toBe("personal-token");
});
