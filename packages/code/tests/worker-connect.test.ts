import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { saveRelayState } from "../src/lib/relay-connect";
import { runWorkerConnectCommand } from "../src/lib/worker-connect";

describe("runWorkerConnectCommand", () => {
  let workspaceDir: string;
  let logs: string[];
  let errors: string[];
  const originalLog = console.log;
  const originalError = console.error;
  const savedLinearKey = process.env.LINEAR_API_KEY;
  const savedWorkspaceDir = process.env.DEVINTERN_WORKSPACE_DIR;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "devintern-worker-connect-"));
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
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
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
    if (savedWorkspaceDir === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = savedWorkspaceDir;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("pairs every unverified workspace repo and continues after a failure", async () => {
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

    const result = await runWorkerConnectCommand([], async () => null, {
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

  test("an explicit repo bypasses fleet-wide connect", async () => {
    const calls: string[][] = [];

    const result = await runWorkerConnectCommand(
      ["github", "--repo", "acme/web"],
      async () => null,
      {
        workspaceDir,
        runConnect: async (args) => {
          calls.push(args);
          return 0;
        },
      },
    );

    expect(result).toBe(0);
    expect(calls).toEqual([["github", "--repo", "acme/web"]]);
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

    const result = await runWorkerConnectCommand(["status"], async () => null, {
      workspaceDir,
      runConnect: async () => 0,
    });

    expect(result).toBe(0);
    expect(logs.join("\n")).toContain("Unverified workspace repositories: acme/web");
  });

  test("tracker connect loads workspace env without overriding the shell", async () => {
    process.env.LINEAR_API_KEY = "shell-key";
    let observedKey: string | undefined;

    const result = await runWorkerConnectCommand(["linear"], async () => null, {
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

  test("falls back to repository-local connect without a workspace", async () => {
    rmSync(join(workspaceDir, "workspace.toml"));
    const calls: string[][] = [];

    const result = await runWorkerConnectCommand([], async () => "acme/local", {
      findProjectEnv: () => null,
      runConnect: async (args, detectRepo) => {
        calls.push(args);
        expect(await detectRepo()).toBe("acme/local");
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(calls).toEqual([["github"]]);
  });
});
