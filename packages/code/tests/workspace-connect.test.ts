import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { saveRelayState } from "../src/lib/relay-connect";
import { runWorkspaceConnect } from "../src/lib/workspace/connect";

describe("runWorkspaceConnect", () => {
  let workspaceDir: string;
  let logs: string[];
  let errors: string[];
  const originalLog = console.log;
  const originalError = console.error;
  const savedLinearKey = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "devintern-workspace-connect-"));
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "workspace.toml"),
      `[defaults]
tracker = "linear"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"

[[repos]]
name = "web"
remote = "https://github.com/acme/web.git"

[[repos]]
name = "mirror"
remote = "https://git.example.com/acme/api.git"
[repos.env]
GITHUB_REPO = "acme/api"
`,
      "utf8",
    );
    writeFileSync(join(workspaceDir, ".env"), "LINEAR_API_KEY=workspace-key\n", "utf8");
    logs = [];
    errors = [];
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (savedLinearKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = savedLinearKey;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("pairs every unverified repo and continues after a failure", async () => {
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: "2026-09-02T00:00:00.000Z",
        registrations: [],
        relayToken: "drt_test",
        githubRepositories: [{ repo: "acme/api", installationId: 10, repositoryId: 20 }],
      },
      workspaceDir,
    );
    const calls: string[][] = [];

    const result = await runWorkspaceConnect([], {
      workspaceDir,
      runConnect: async (args) => {
        calls.push(args);
        return args.includes("acme/web") ? 1 : 0;
      },
    });

    expect(result).toBe(1);
    expect(calls).toEqual([["github", "--repo", "acme/web"]]);
    expect(logs.join("\n")).toContain("acme/api is already verified");
    expect(errors.join("\n")).toContain("1 workspace repository pairing(s) failed");
  });

  test("status reports workspace repos without verified pairing", async () => {
    saveRelayState(
      {
        relayUrl: "https://relay.test",
        customerId: "customer-1",
        connectedAt: "2026-09-02T00:00:00.000Z",
        registrations: [],
        relayToken: "drt_test",
        githubRepositories: [{ repo: "acme/api", installationId: 10, repositoryId: 20 }],
      },
      workspaceDir,
    );

    const result = await runWorkspaceConnect(["status"], {
      workspaceDir,
      runConnect: async () => 0,
    });

    expect(result).toBe(0);
    expect(logs.join("\n")).toContain("Unverified workspace repositories: acme/web");
  });

  test("tracker connect loads workspace env without overriding the shell", async () => {
    process.env.LINEAR_API_KEY = "shell-key";
    let observedKey: string | undefined;

    const result = await runWorkspaceConnect(["linear"], {
      workspaceDir,
      runConnect: async (args) => {
        expect(args).toEqual(["linear"]);
        observedKey = process.env.LINEAR_API_KEY;
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(observedKey).toBe("shell-key");
  });
});
