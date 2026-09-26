import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { workspaceCredentialsForChange } from "../src/lib/workspace/manual-credentials";

describe("manual change-request workspace credentials", () => {
  let root: string;
  let checkout: string;
  let workspaceDir: string;
  const originalWorkerMarker = process.env.DEVINTERN_WORKER_SUBPROCESS;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "manual-workspace-credentials-"));
    checkout = join(root, "checkout");
    workspaceDir = join(root, "workspace");
    mkdirSync(checkout);
    mkdirSync(join(workspaceDir, "env"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: checkout });
    spawnSync("git", ["remote", "add", "origin", "git@github.com:danii1/devintern.git"], {
      cwd: checkout,
    });
    writeFileSync(
      join(workspaceDir, ".env"),
      "GITHUB_TOKEN=shared\nAGENT_HARNESS=workspace-agent\n",
    );
    writeFileSync(join(workspaceDir, "env", "private.env"), "GITHUB_TOKEN=repo-file\n");
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "markdown"

[[repos]]
name = "other"
remote = "https://github.com/acme/other.git"
  [repos.env]
  GITHUB_TOKEN = "other-repo"

[[repos]]
name = "private"
remote = "https://github.com/danii1/devintern.git"
env_file = "env/private.env"
  [repos.env]
  GITHUB_TOKEN = "repo-inline"
`,
    );
  });

  afterEach(() => {
    if (originalWorkerMarker === undefined) delete process.env.DEVINTERN_WORKER_SUBPROCESS;
    else process.env.DEVINTERN_WORKER_SUBPROCESS = originalWorkerMarker;
    rmSync(root, { recursive: true, force: true });
  });

  test("uses shared and repo layers for a registered origin and matching PR", async () => {
    const credentials = await workspaceCredentialsForChange(
      "https://github.com/danii1/devintern/pull/205",
      { cwd: checkout, workspaceDir },
    );
    expect(credentials).toMatchObject({
      GITHUB_TOKEN: "repo-inline",
      AGENT_HARNESS: "workspace-agent",
    });
    expect(credentials).not.toHaveProperty("DEVINTERN_WORKER_SUBPROCESS");
  });

  test("does not use a different repository's workspace credentials", async () => {
    expect(
      await workspaceCredentialsForChange("https://github.com/acme/other/pull/7", {
        cwd: checkout,
        workspaceDir,
      }),
    ).toBeNull();
  });

  test("leaves an already-composed worker subprocess alone", async () => {
    process.env.DEVINTERN_WORKER_SUBPROCESS = "1";
    expect(
      await workspaceCredentialsForChange("https://github.com/danii1/devintern/pull/205", {
        cwd: checkout,
        workspaceDir,
      }),
    ).toBeNull();
  });
});
