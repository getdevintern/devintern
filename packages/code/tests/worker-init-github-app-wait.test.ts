import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { waitForGitHubAppInstall } from "../src/lib/init/worker-init-github-app-wait";
import type { GitHubAppWaitDeps } from "../src/lib/init/worker-init-github-app-wait";
import {
  loadPendingGitHubPairing,
  savePendingGitHubPairing,
} from "../src/lib/relay/github-pairing";
import type { PendingGitHubPairing } from "../src/lib/relay/github-pairing";
import type { RelayConnectState } from "../src/lib/relay/state";

const RELAY_URL = "https://relay.test";

describe("waitForGitHubAppInstall", () => {
  let workspaceDir: string;
  let lines: string[];

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "devintern-app-wait-"));
    lines = [];
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const pairing: PendingGitHubPairing = {
    id: "pair-1",
    installUrl: "https://github.com/apps/devintern-ai/installations/new?state=pair-1",
    pairingStatusUrl: `${RELAY_URL}/v1/github/pairings/pair-1`,
    expiresAt: Date.now() + 10 * 60_000,
    repos: ["acme/app"],
    relayUrl: RELAY_URL,
  };

  function stateWith(repos: string[]): RelayConnectState {
    return {
      relayUrl: RELAY_URL,
      customerId: "cust-1",
      connectedAt: new Date().toISOString(),
      registrations: [],
      githubRepositories: repos.map((repo, index) => ({
        repo,
        installationId: 1,
        repositoryId: index + 1,
      })),
    };
  }

  function run(overrides: GitHubAppWaitDeps = {}) {
    return waitForGitHubAppInstall(
      {
        pairing,
        getAccessToken: async () => "supa-access",
        workspaceDir,
        log: (line) => lines.push(line),
      },
      {
        openUrl: async () => {},
        watchSkip: () => ({ skipped: new Promise(() => {}), stop: () => {} }),
        sleep: async () => {},
        poll: async () => ({ kind: "pending" }),
        ...overrides,
      },
    );
  }

  test("a complete pairing that granted the repository is installed", async () => {
    savePendingGitHubPairing(pairing, workspaceDir);
    const result = await run({
      poll: async () => ({ kind: "complete", state: stateWith(["acme/app"]) }),
    });
    expect(result).toBe("installed");
    expect(lines).toContain("✅ DevIntern GitHub App installed and verified.");
    expect(loadPendingGitHubPairing(workspaceDir)).toBeNull();
  });

  test("a complete pairing that granted other repositories is partial, not installed", async () => {
    savePendingGitHubPairing(pairing, workspaceDir);
    const missing: string[][] = [];
    const result = await run({
      poll: async () => ({ kind: "complete", state: stateWith(["acme/other"]) }),
      onMissingRepositories: (repos) => missing.push(repos),
    });
    expect(result).toBe("partial");
    expect(missing).toEqual([["acme/app"]]);
    expect(lines.join("\n")).toContain("The App installation did not grant: acme/app");
    expect(lines.join("\n")).not.toContain("installed and verified");
    // The pairing is spent, exactly as `connect github --status` treats a complete one.
    expect(loadPendingGitHubPairing(workspaceDir)).toBeNull();
  });
});
