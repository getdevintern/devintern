import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { GitHubReviewsClient } from "../src/lib/code-host/github/reviews";
import type { ReviewsClientConfig } from "../src/lib/code-host/github/reviews";
import { saveRelayState } from "../src/lib/relay/connect";
import type { WorkspaceConfig } from "../src/lib/workspace/config";
import { createStackedPrGitHubResolver } from "../src/lib/workspace/stacked-pr-acquirer";

const ENV_KEYS = [
  "DEVINTERN_GITHUB_AUTH_MODE",
  "WORKER_RELAY_URL",
  "GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
] as const;

// No configured repo matches, so the resolver falls back to GITHUB_TOKEN.
const CONFIG = { repos: [] } as unknown as WorkspaceConfig;

/** Records the auth mode each client is constructed with. */
const constructed: Array<ReviewsClientConfig["authMode"]> = [];
class RecordingClient extends GitHubReviewsClient {
  constructor(config: ReviewsClientConfig = {}) {
    super(config);
    constructed.push(config.authMode);
  }
}

describe("stacked-PR GitHub auth mode", () => {
  let workspaceDir: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "stacked-pr-auth-"));
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    for (const key of ENV_KEYS) delete process.env[key];
    // Custom App credentials present, as in the failing relay workspace.
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = join(workspaceDir, "custom-app.pem");
    process.env.GITHUB_TOKEN = "ghp_test";
    constructed.length = 0;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("relay-hosted workspace uses token-only before the event wiring sets the env", async () => {
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: new Date(0).toISOString(),
        registrations: [
          { kind: "repo", key: "acme/backend", createdAt: Date.now(), lastEventAt: null },
        ],
        relayToken: "drt_test",
      },
      workspaceDir,
    );

    const gh = await createStackedPrGitHubResolver(CONFIG, workspaceDir, RecordingClient);
    gh("acme/backend");

    expect(process.env.DEVINTERN_GITHUB_AUTH_MODE).toBeUndefined();
    expect(constructed).toEqual(["token-only"]);
  });

  test("workspace without a relay keeps app-first", async () => {
    const gh = await createStackedPrGitHubResolver(CONFIG, workspaceDir, RecordingClient);
    gh("acme/backend");

    expect(constructed).toEqual(["app-first"]);
  });
});
