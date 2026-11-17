import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { buildFleetEventAcquirers } from "../src/lib/workspace/fleet-event-acquirers";
import { workspaceEnvPath } from "../src/lib/workspace/paths";
import { openWorkspaceState } from "../src/lib/workspace/state";
import {
  assertTeamPrSyncSandbox,
  teamPrSyncSandboxProblems,
  teamPrSyncSlugs,
} from "../src/lib/workspace/team-pr-sync";
import type { RepoManagerLike } from "../src/lib/workspace/workspace-worker";
import { validateReloadedWorkspaceConfig } from "../src/lib/workspace/workspace-worker";

const BASE = `
[defaults]
tracker = "markdown"

[[repos]]
name = "backend"
remote = "git@github.com:acme/backend.git"

[[repos]]
name = "frontend"
remote = "git@github.com:acme/frontend.git"
`;

/** BASE with `sync_team_prs = true` (and optional inline env) on backend. */
function optedIn(inlineEnv = ""): string {
  return BASE.replace(
    'remote = "git@github.com:acme/backend.git"',
    'remote = "git@github.com:acme/backend.git"\nsync_team_prs = true' +
      (inlineEnv ? `\n[repos.env]\n${inlineEnv}` : ""),
  );
}

describe("sync_team_prs sandbox gate", () => {
  let workspaceDir: string;
  let savedSandbox: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "team-pr-sync-"));
    // The developer's shell may carry AGENT_SANDBOX; pin it per test.
    savedSandbox = process.env.AGENT_SANDBOX;
    delete process.env.AGENT_SANDBOX;
  });

  afterEach(() => {
    if (savedSandbox === undefined) delete process.env.AGENT_SANDBOX;
    else process.env.AGENT_SANDBOX = savedSandbox;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("lists only opted-in GitHub slugs", () => {
    expect(teamPrSyncSlugs(parseWorkspaceConfig(BASE))).toEqual([]);
    expect(teamPrSyncSlugs(parseWorkspaceConfig(optedIn()))).toEqual(["acme/backend"]);
  });

  test("no repo opted in never requires a sandbox", () => {
    expect(teamPrSyncSandboxProblems(parseWorkspaceConfig(BASE), workspaceDir)).toEqual([]);
  });

  test("unset, none, auto, and unknown providers are refused", () => {
    const config = parseWorkspaceConfig(optedIn());
    expect(teamPrSyncSandboxProblems(config, workspaceDir)).toEqual([
      "backend (AGENT_SANDBOX=<unset>)",
    ]);
    for (const value of ["none", "auto", "bogus"]) {
      process.env.AGENT_SANDBOX = value;
      expect(teamPrSyncSandboxProblems(config, workspaceDir)).toEqual([
        `backend (AGENT_SANDBOX=${value})`,
      ]);
    }
    process.env.AGENT_SANDBOX = "nono";
    expect(teamPrSyncSandboxProblems(config, workspaceDir)).toEqual([]);
  });

  test("uses the repo's effective env: workspace .env, then repo env overrides", () => {
    writeFileSync(workspaceEnvPath(workspaceDir), "AGENT_SANDBOX=native\n");
    expect(teamPrSyncSandboxProblems(parseWorkspaceConfig(optedIn()), workspaceDir)).toEqual([]);

    // An inline [repos.env] override to none wins over the workspace .env.
    const overridden = parseWorkspaceConfig(optedIn('AGENT_SANDBOX = "none"'));
    expect(teamPrSyncSandboxProblems(overridden, workspaceDir)).toEqual([
      "backend (AGENT_SANDBOX=none)",
    ]);

    // So does a repo env_file.
    writeFileSync(join(workspaceDir, "backend.env"), "AGENT_SANDBOX=none\n");
    const viaFile = parseWorkspaceConfig(
      optedIn().replace("sync_team_prs = true", 'sync_team_prs = true\nenv_file = "backend.env"'),
    );
    expect(teamPrSyncSandboxProblems(viaFile, workspaceDir)).toEqual([
      "backend (AGENT_SANDBOX=none)",
    ]);
  });

  test("the error names every offending repo", () => {
    const config = parseWorkspaceConfig(
      optedIn().replace(
        'remote = "git@github.com:acme/frontend.git"',
        'remote = "git@github.com:acme/frontend.git"\nsync_team_prs = true',
      ),
    );
    expect(() => assertTeamPrSyncSandbox(config, workspaceDir)).toThrow(
      /sync_team_prs requires an explicit agent sandbox.*backend \(AGENT_SANDBOX=<unset>\), frontend \(AGENT_SANDBOX=<unset>\)/s,
    );
  });

  test("a reload enabling sync_team_prs without a sandbox is rejected", () => {
    const current = parseWorkspaceConfig(BASE);
    const context = { multiTeam: false, sourceCount: 1, workspaceDir };
    expect(() =>
      validateReloadedWorkspaceConfig(parseWorkspaceConfig(optedIn()), current, context),
    ).toThrow(/sync_team_prs requires an explicit agent sandbox.*backend/s);
    expect(current.repos[0]?.syncTeamPrs).toBeUndefined();

    // A repo-env override to none is rejected even when the workspace .env is sandboxed.
    writeFileSync(workspaceEnvPath(workspaceDir), "AGENT_SANDBOX=nono\n");
    expect(() =>
      validateReloadedWorkspaceConfig(parseWorkspaceConfig(optedIn()), current, context),
    ).not.toThrow();
    expect(() =>
      validateReloadedWorkspaceConfig(
        parseWorkspaceConfig(optedIn('AGENT_SANDBOX = "none"')),
        current,
        context,
      ),
    ).toThrow(/backend \(AGENT_SANDBOX=none\)/);
  });

  test("fleet event wiring refuses to start without a sandbox", async () => {
    const state = openWorkspaceState(workspaceDir);
    try {
      await expect(
        buildFleetEventAcquirers({
          config: parseWorkspaceConfig(optedIn('AGENT_SANDBOX = "none"')),
          workspaceDir,
          state,
          repoManager: {} as RepoManagerLike,
          intervalSeconds: 60,
        }),
      ).rejects.toThrow(/sync_team_prs requires an explicit agent sandbox.*backend/s);
    } finally {
      state.close();
    }
  });
});
