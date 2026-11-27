import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { WorkerConnectCommandDeps } from "../src/lib/init/worker-connect";
import { runWorkerSignInFollowUp } from "../src/lib/init/worker-sign-in-followup";
import type { ServiceCommandReport } from "../src/lib/worker/service-command";
import {
  loadWorkerStartIntent,
  saveWorkerStartIntent,
  WORKER_START_INTENT_TTL_MS,
  workerStartIntentPath,
} from "../src/lib/worker/start-intent";

const GITHUB_WORKSPACE =
  '[defaults]\ntracker = "markdown"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n';

describe("runWorkerSignInFollowUp", () => {
  let workspaceDir: string;
  let configPath: string;
  let lines: string[];

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "devintern-sign-in-followup-"));
    configPath = join(workspaceDir, "workspace.toml");
    writeFileSync(configPath, GITHUB_WORKSPACE);
    lines = [];
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const options = (overrides: Partial<Parameters<typeof runWorkerSignInFollowUp>[0]> = {}) => ({
    workspaceDir,
    configPath,
    json: true,
    noRelay: false,
    signedIn: true,
    log: (line: string) => lines.push(line),
    ...overrides,
  });

  /** `worker connect --no-wait --json` stub: one pending GitHub pairing. */
  const pendingConnect =
    (calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }>) =>
    async (args: string[], deps: WorkerConnectCommandDeps = {}) => {
      calls.push({ args, deps });
      deps.writeStderr?.("Open this URL to install and authorize the DevIntern GitHub App:\n");
      deps.writeStdout?.(
        JSON.stringify({
          schema: "devintern.worker-connect",
          version: 1,
          target: "all",
          result: "pending",
          nextSteps: [
            {
              id: "authorize-github-app",
              message: "Approve",
              command: "https://github.com/apps/x",
              url: "https://github.com/apps/x",
            },
          ],
        }),
      );
      return 0;
    };

  const running: ServiceCommandReport = {
    schema: "devintern.worker-service",
    version: 1,
    action: "install",
    result: "running",
    workspaceDir: "",
    warnings: [],
    nextSteps: [],
  };

  test("pairs the relay like `worker connect --no-wait --json` and reports its document", async () => {
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    const result = await runWorkerSignInFollowUp(options(), { connect: pendingConnect(calls) });
    expect(calls.map((call) => call.args)).toEqual([["--no-wait", "--json"]]);
    expect(calls[0]?.deps.workspacePath).toBe(configPath);
    expect(result.relay).toMatchObject({ schema: "devintern.worker-connect", result: "pending" });
    expect(result.service).toBeUndefined();
    expect(result.nextSteps?.map((step) => step.id)).toEqual(["authorize-github-app"]);
    expect(lines).toContain("Open this URL to install and authorize the DevIntern GitHub App:");
  });

  test("--no-relay skips pairing", async () => {
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    const result = await runWorkerSignInFollowUp(options({ noRelay: true }), {
      connect: pendingConnect(calls),
    });
    expect(calls).toEqual([]);
    expect(result.relay).toMatchObject({ result: "skipped", code: "no_relay" });
  });

  test("a workspace without GitHub or GitLab repositories has nothing to pair", async () => {
    writeFileSync(configPath, '[defaults]\ntracker = "markdown"\n');
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    const result = await runWorkerSignInFollowUp(options(), { connect: pendingConnect(calls) });
    expect(calls).toEqual([]);
    expect(result.relay).toMatchObject({ result: "skipped", code: "no_relay_sources" });
  });

  test("a `worker init --start` waiting for the sign-in installs the service once", async () => {
    saveWorkerStartIntent(workspaceDir, { requestedAt: new Date().toISOString(), relay: true });
    expect(statSync(workerStartIntentPath(workspaceDir)).mode & 0o777).toBe(0o600);
    const installs: string[] = [];
    const deps = {
      connect: pendingConnect([]),
      installService: async (dir: string) => {
        installs.push(dir);
        return running;
      },
    };
    const result = await runWorkerSignInFollowUp(options(), deps);
    expect(installs).toEqual([workspaceDir]);
    expect(result.service?.result).toBe("running");
    expect(existsSync(workerStartIntentPath(workspaceDir))).toBe(false);

    await runWorkerSignInFollowUp(options(), deps);
    expect(installs).toHaveLength(1);
  });

  test("an existing session (--no-wait) pairs only; the deferred start waits for the sign-in", async () => {
    saveWorkerStartIntent(workspaceDir, { requestedAt: new Date().toISOString(), relay: true });
    let installs = 0;
    const result = await runWorkerSignInFollowUp(options({ signedIn: false }), {
      connect: pendingConnect([]),
      installService: async () => {
        installs += 1;
        return running;
      },
    });
    expect(installs).toBe(0);
    expect(result.service).toBeUndefined();
    expect(loadWorkerStartIntent(workspaceDir)).not.toBeNull();
  });

  test("an intent recorded with --no-relay skips pairing on the completing sign-in", async () => {
    saveWorkerStartIntent(workspaceDir, { requestedAt: new Date().toISOString(), relay: false });
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    const result = await runWorkerSignInFollowUp(options(), {
      connect: pendingConnect(calls),
      installService: async () => running,
    });
    expect(calls).toEqual([]);
    expect(result.relay).toMatchObject({ result: "skipped", code: "no_relay" });
    expect(result.service?.result).toBe("running");
  });

  test("a relay-only intent (--no-relay without --start) skips pairing, starts no service, and is used once", async () => {
    saveWorkerStartIntent(workspaceDir, {
      requestedAt: new Date().toISOString(),
      relay: false,
      start: false,
    });
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    let installs = 0;
    const deps = {
      connect: pendingConnect(calls),
      installService: async () => {
        installs += 1;
        return running;
      },
    };
    const result = await runWorkerSignInFollowUp(options(), deps);
    expect(calls).toEqual([]);
    expect(installs).toBe(0);
    expect(result.service).toBeUndefined();
    expect(result.relay).toMatchObject({ result: "skipped", code: "no_relay" });
    expect(existsSync(workerStartIntentPath(workspaceDir))).toBe(false);

    // The choice applied to that sign-in only; the next one pairs as usual.
    const next = await runWorkerSignInFollowUp(options(), deps);
    expect(calls.map((call) => call.args)).toEqual([["--no-wait", "--json"]]);
    expect(next.relay).toMatchObject({ schema: "devintern.worker-connect", result: "pending" });
  });

  test("a relay-only intent recorded before the completed sign-in is ignored and cleared", async () => {
    saveWorkerStartIntent(workspaceDir, {
      requestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      relay: false,
      start: false,
    });
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    const result = await runWorkerSignInFollowUp(
      options({ pendingSignInStartedAt: new Date(Date.now() - 60_000).toISOString() }),
      { connect: pendingConnect(calls) },
    );
    expect(calls.map((call) => call.args)).toEqual([["--no-wait", "--json"]]);
    expect(result.relay).toMatchObject({ schema: "devintern.worker-connect", result: "pending" });
    expect(existsSync(workerStartIntentPath(workspaceDir))).toBe(false);
  });

  test("a relay-only intent recorded for the completed sign-in still skips pairing", async () => {
    saveWorkerStartIntent(workspaceDir, {
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      relay: false,
      start: false,
    });
    const calls: Array<{ args: string[]; deps: WorkerConnectCommandDeps }> = [];
    const result = await runWorkerSignInFollowUp(
      options({ pendingSignInStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
      { connect: pendingConnect(calls) },
    );
    expect(calls).toEqual([]);
    expect(result.relay).toMatchObject({ result: "skipped", code: "no_relay" });
  });

  test("a deferred --start intent still starts the service for a sign-in that began later", async () => {
    saveWorkerStartIntent(workspaceDir, {
      requestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      relay: true,
    });
    let installs = 0;
    const result = await runWorkerSignInFollowUp(
      options({ pendingSignInStartedAt: new Date(Date.now() - 60_000).toISOString() }),
      {
        connect: pendingConnect([]),
        installService: async () => {
          installs += 1;
          return running;
        },
      },
    );
    expect(installs).toBe(1);
    expect(result.service?.result).toBe("running");
  });

  test("an intent older than the pending sign-in is ignored", async () => {
    const stale = new Date(Date.now() - WORKER_START_INTENT_TTL_MS - 60_000).toISOString();
    saveWorkerStartIntent(workspaceDir, { requestedAt: stale, relay: true });
    expect(loadWorkerStartIntent(workspaceDir)).toBeNull();
    let installs = 0;
    const result = await runWorkerSignInFollowUp(options({ noRelay: true }), {
      installService: async () => {
        installs += 1;
        return running;
      },
    });
    expect(installs).toBe(0);
    expect(result.service).toBeUndefined();
  });

  test("a failed install is reported in the service document", async () => {
    saveWorkerStartIntent(workspaceDir, { requestedAt: new Date().toISOString(), relay: true });
    const result = await runWorkerSignInFollowUp(options({ noRelay: true }), {
      installService: async () => {
        throw new Error("systemctl missing");
      },
    });
    expect(result.service).toMatchObject({
      result: "error",
      code: "service_command_failed",
      error: "systemctl missing",
    });
    // The request was spent, and the report names the command that retries it.
    expect(existsSync(workerStartIntentPath(workspaceDir))).toBe(false);
    expect(result.nextSteps?.map((step) => step.id)).toEqual(["service"]);
    expect(result.nextSteps?.[0]?.command).toContain("worker service install");
  });

  test("a failing relay pairing still installs the deferred service", async () => {
    saveWorkerStartIntent(workspaceDir, { requestedAt: new Date().toISOString(), relay: true });
    const installs: string[] = [];
    const result = await runWorkerSignInFollowUp(options(), {
      connect: async () => {
        throw new Error("relay down");
      },
      installService: async (dir: string) => {
        installs.push(dir);
        return running;
      },
    });
    expect(installs).toEqual([workspaceDir]);
    expect(result.relay).toMatchObject({ result: "failure", code: "connect_failed" });
    expect((result.relay as { error?: string }).error).toContain("relay down");
    expect(result.service?.result).toBe("running");
    expect(existsSync(workerStartIntentPath(workspaceDir))).toBe(false);
    expect(result.nextSteps?.map((step) => step.id)).toEqual(["pair-relay"]);
  });
});
