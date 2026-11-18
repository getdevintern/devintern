/**
 * Proves the built CLI's automation license gate fails closed offline, and pins
 * the signed-out `whoami`/`logout` behavior when Supabase is unreachable.
 *
 * Every other e2e test sets `DEVINTERN_SKIP_LICENSE_CHECK=1`; these cases
 * remove it so `checkLicense` (packages/license-check/src/index.ts) really
 * runs. Every child routes HTTP(S) through a loopback recording proxy that
 * refuses every tunnel, so Polar (`api.polar.sh`), Supabase, and devintern.com
 * are all unreachable and nothing leaves the machine. Only fake credentials
 * are used, and the tests assert none of them is echoed.
 *
 * Session files live where the CLI reads them: `<project>/.devintern-code/`
 * for a task run and `<workspace>/state/code/` for the worker
 * (`loadSupabaseConfig`, packages/code/src/lib/cli/bootstrap.ts).
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { FixtureWorkspace, cliPath } from "../../helpers/fixture-workspace";
import type { CommandResult } from "../../helpers/process";
import { checkedCommand, command } from "../../helpers/process";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import { WorkerFixture } from "../../helpers/worker";

const skip = !existsSync(cliPath);

/** `AUTOMATION_ACCESS_EXIT_CODE` (packages/code/src/lib/worker/usage-limit-protocol.ts). */
const AUTOMATION_ACCESS_EXIT_CODE = 77;
/** `POLAR_API_BASE` host (packages/license-policy/src/index.ts). */
const POLAR_HOST = "api.polar.sh";
/** `DEFAULT_SUPABASE_URL` host (packages/auth/src/index.ts). */
const SUPABASE_HOST = "robbzuhuqcgpfevaorux.supabase.co";

const FAKE_LICENSE_KEY = "E2E-FAKE-LICENSE-KEY-not-a-real-key-0000";
const FAKE_REFRESH_TOKEN = "e2e-fake-refresh-token-not-real";
const FAKE_SIGNATURE = "e2e-fake-signature-not-real";

const AUTOMATION_DENIAL =
  "Automated execution detected (CI / systemd / cron) but no automation license was found.";
const LICENSE_KEY_GUIDANCE =
  "Set LICENSE_KEY to a Supporter, Team, or Business license key from https://devintern.com/account";
const SIGN_IN_ALTERNATIVE = "Alternatively, sign in if your account already holds one.";
const WORKER_PILOT_ALTERNATIVE =
  "Alternatively, run `devintern login` to start a free Worker Pilot; no card is required.";
const NOT_SIGNED_IN = "Not signed in. Run `devintern login`.";

/**
 * A syntactically valid Supabase session whose fake JWT Supabase would reject.
 *
 * `expired: true` sets `exp` in the past so `setSession` must refresh (the
 * refresh-retry path); otherwise the token is unexpired and `getUser` is the
 * first network call.
 */
function writeFakeSession(path: string, options: { expired: boolean }): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = options.expired ? 1 : Math.floor(Date.now() / 1000) + 3600;
  const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "e2e-fake-user", exp })}.${FAKE_SIGNATURE}`;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      accessToken,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: exp,
      user: { id: "e2e-fake-user", email: "e2e@example.invalid", createdAt: null },
    }),
  );
  return accessToken;
}

/** No fake credential (license key, tokens, JWT parts) appears in the output. */
function expectNoSecrets(result: CommandResult, accessToken?: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of [FAKE_LICENSE_KEY, FAKE_REFRESH_TOKEN, FAKE_SIGNATURE, accessToken]) {
    if (secret) expect(output).not.toContain(secret);
  }
}

/** Every recorded host is in `allowed`; returns the distinct hosts seen. */
function expectOnlyHosts(proxy: RecordingProxy, allowed: string[]): string[] {
  const hosts = [...new Set(proxy.requests().map((request) => request.host))];
  expect(hosts.filter((host) => !allowed.includes(host))).toEqual([]);
  return hosts;
}

/** Preload that pins the CLI's `/proc/self/cgroup` view (helpers/fake-cgroup-preload.cjs). */
const FAKE_CGROUP_PRELOAD = join(import.meta.dir, "../../helpers/fake-cgroup-preload.cjs");

/**
 * Runs the task with `CI` unset and the CLI seeing `cgroup` as its
 * `/proc/self/cgroup`, so `isAutomatedEnvironment`
 * (packages/code/src/lib/config/env-detector.ts) decides from that unit, not
 * from whatever unit hosts this test run (a terminal `.scope` or a worker
 * `.service`). Both branches therefore run on every Linux host.
 */
function runWithoutCi(run: FixtureWorkspace, cgroup: string): Promise<CommandResult> {
  delete run.env.CI;
  delete run.env.SYSTEMD_EXEC_PID;
  run.env.E2E_FAKE_CGROUP = cgroup;
  return run.runTask({ bunArgs: ["--preload", FAKE_CGROUP_PRELOAD] });
}

const TERMINAL_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/e2e-terminal.scope\n";
const SERVICE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/e2e-worker.service\n";

/** Markdown task run against a local bare remote, with the gate enabled. */
async function withGatedTaskRun(
  body: (run: FixtureWorkspace, proxy: RecordingProxy) => Promise<void>,
): Promise<void> {
  const proxy = await startRecordingProxy();
  const run = new FixtureWorkspace();
  try {
    const remote = join(run.root, "remote.git");
    await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
    await run.prepare(remote, "test-token", {});
    delete run.env.DEVINTERN_SKIP_LICENSE_CHECK;
    Object.assign(run.env, proxyEnvironment(proxy.url));
    await body(run, proxy);
  } finally {
    run.dispose();
    await proxy.close();
  }
}

/** The agent never ran and nothing reached the bare remote or a feature branch. */
async function expectNoWork(run: FixtureWorkspace): Promise<void> {
  expect(run.agentInvocations()).toEqual([]);
  expect(await run.remoteSha(run.head)).toBeUndefined();
  expect(await run.git("branch", "--list", run.head)).toBe("");
  const baseSha = await run.remoteSha(run.base);
  expect(baseSha).toBeDefined();
  expect(await run.git("rev-parse", "HEAD")).toBe(baseSha ?? "");
}

test.skipIf(skip)(
  "an automated task run with no LICENSE_KEY and no session fails closed with exit 77 and no egress",
  async () => {
    await withGatedTaskRun(async (run, proxy) => {
      const result = await run.runTask();
      expect(result.exitCode).toBe(AUTOMATION_ACCESS_EXIT_CODE);
      expect(result.stderr).toContain("❌ License check failed");
      expect(result.stderr).toContain(AUTOMATION_DENIAL);
      expect(result.stderr).toContain(LICENSE_KEY_GUIDANCE);
      expect(result.stderr).toContain(SIGN_IN_ALTERNATIVE);
      expect(result.stderr).not.toContain("Worker Pilot");
      // No key and no session: neither Polar, Supabase nor devintern.com is contacted.
      expect(proxy.requests()).toEqual([]);
      await expectNoWork(run);
      expect(existsSync(run.env.WEBHOOK_QUEUE_DB) ? run.runRecords() : []).toEqual([]);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "a Worker Pilot task run (DEVINTERN_WORKER_TRIAL=1) without a session points at devintern login",
  async () => {
    await withGatedTaskRun(async (run, proxy) => {
      run.env.DEVINTERN_WORKER_TRIAL = "1";
      const result = await run.runTask();
      expect(result.exitCode).toBe(AUTOMATION_ACCESS_EXIT_CODE);
      expect(result.stderr).toContain(AUTOMATION_DENIAL);
      expect(result.stderr).toContain(LICENSE_KEY_GUIDANCE);
      expect(result.stderr).toContain(WORKER_PILOT_ALTERNATIVE);
      expect(proxy.requests()).toEqual([]);
      await expectNoWork(run);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "a fake LICENSE_KEY with Polar unreachable fails closed without printing the key",
  async () => {
    await withGatedTaskRun(async (run, proxy) => {
      run.env.LICENSE_KEY = FAKE_LICENSE_KEY;
      const result = await run.runTask();
      expect(result.exitCode).toBe(AUTOMATION_ACCESS_EXIT_CODE);
      expect(result.stderr).toContain("❌ License check failed");
      expect(result.stderr).toContain("License validation failed:");
      expectNoSecrets(result);
      // The explicit key is validated against Polar only; no cached entitlement
      // exists, so the 72-hour grace path cannot open the gate.
      expect(proxy.requestsTo(POLAR_HOST).length).toBeGreaterThan(0);
      expectOnlyHosts(proxy, [POLAR_HOST]);
      await expectNoWork(run);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "an unrefreshable session with Supabase unreachable resolves to signed out and fails closed",
  async () => {
    await withGatedTaskRun(async (run, proxy) => {
      // Expired token: supabase-js retries the refresh for ~25 s before giving up.
      const accessToken = writeFakeSession(join(run.cwd, ".devintern-code/.auth-session.json"), {
        expired: true,
      });
      const result = await run.runTask();
      expect(result.exitCode).toBe(AUTOMATION_ACCESS_EXIT_CODE);
      expect(result.stderr).toContain(AUTOMATION_DENIAL);
      // The user resolved to null: the signed-out hint is shown and the
      // devintern.com entitlement check was never attempted.
      expect(result.stderr).toContain(SIGN_IN_ALTERNATIVE);
      expect(result.stderr).not.toContain("License entitlement check failed");
      expectNoSecrets(result, accessToken);
      expect(proxy.requestsTo(SUPABASE_HOST).length).toBeGreaterThan(0);
      expectOnlyHosts(proxy, [SUPABASE_HOST]);
      await expectNoWork(run);
    });
  },
  90_000,
);

test.skipIf(skip)(
  "an interactive task run (terminal scope, no CI) skips the license check and completes",
  async () => {
    await withGatedTaskRun(async (run, proxy) => {
      const result = await runWithoutCi(run, TERMINAL_CGROUP);
      // Interactive use is free under FSL: no license is checked at all.
      if (result.exitCode !== 0) {
        throw new Error(`CLI exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
      }
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("License check failed");
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual(["implement"]);
      expect(await run.remoteSha(run.head)).toBeDefined();
      expect(proxy.requestsTo(POLAR_HOST)).toEqual([]);
      expect(proxy.requestsTo(SUPABASE_HOST)).toEqual([]);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "a task run inside a systemd service without CI still fails closed with exit 77",
  async () => {
    await withGatedTaskRun(async (run, proxy) => {
      const result = await runWithoutCi(run, SERVICE_CGROUP);
      // A systemd service (e.g. a DevIntern worker) counts as unattended, so
      // the gate applies without CI.
      expect(result.exitCode).toBe(AUTOMATION_ACCESS_EXIT_CODE);
      expect(result.stderr).toContain(AUTOMATION_DENIAL);
      expect(proxy.requests()).toEqual([]);
      await expectNoWork(run);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "devintern worker refuses to start without a license and runs no queued task",
  async () => {
    const proxy = await startRecordingProxy();
    const worker = new WorkerFixture({ rootPrefix: "devintern-e2e-license-worker-" });
    try {
      await worker.prepare();
      // Enqueue while the gate is still off: `worker add` itself is not gated.
      await worker.addTask({ title: "Gated task", body: "Must never run without a license." });
      delete worker.env.DEVINTERN_SKIP_LICENSE_CHECK;
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      worker.start();
      const deadline = Date.now() + 30_000;
      while (worker.exitStatus === undefined && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      if (worker.exitStatus === undefined) {
        throw new Error(`Worker kept running without a license:\n${worker.tail()}`);
      }
      expect(worker.exitStatus).toBe(1);
      expect(worker.logs).toContain("❌ License check failed");
      expect(worker.logs).toContain(AUTOMATION_DENIAL);
      // The worker allows the trial, so it points a signed-out user at login.
      expect(worker.logs).toContain(WORKER_PILOT_ALTERNATIVE);
      expect(worker.logs).not.toContain("Draining injected tasks");
      expect(worker.agentInvocations()).toEqual([]);
      expect(worker.agentTimeline()).toEqual([]);
      const heads = await checkedCommand(
        ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
        worker.remote,
        worker.env,
      );
      expect(heads.split("\n")).toEqual([worker.baseBranch]);
      expect(proxy.requests()).toEqual([]);
    } finally {
      await worker.dispose();
      await proxy.close();
    }
  },
  60_000,
);

/** Account commands in a bare temp project, with Supabase refused by the proxy. */
async function withAccountProject(
  body: (run: (args: string[]) => Promise<CommandResult>, sessionPath: string) => Promise<void>,
  proxyCheck: (proxy: RecordingProxy) => void,
): Promise<void> {
  const proxy = await startRecordingProxy();
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-account-"));
  try {
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".devintern-code"), { recursive: true });
    const env = { ...isolatedEnvironment(root), ...proxyEnvironment(proxy.url) };
    delete (env as Record<string, string>).DEVINTERN_SKIP_LICENSE_CHECK;
    await body(
      (args) => command([process.execPath, cliPath, ...args], cwd, env, 90_000),
      join(cwd, ".devintern-code/.auth-session.json"),
    );
    proxyCheck(proxy);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await proxy.close();
  }
}

test.skipIf(skip)(
  "whoami and logout with no session report signed out and make no network calls",
  async () => {
    await withAccountProject(
      async (run, sessionPath) => {
        const whoami = await run(["whoami"]);
        expect(whoami.exitCode).toBe(0);
        expect(whoami.stdout.trim()).toBe(NOT_SIGNED_IN);
        const logout = await run(["logout"]);
        expect(logout.exitCode).toBe(0);
        expect(logout.stdout.trim()).toBe("✅ Signed out");
        expect(existsSync(sessionPath)).toBe(false);
      },
      (proxy) => expect(proxy.requests()).toEqual([]),
    );
  },
  30_000,
);

test.skipIf(skip)(
  "whoami with an unverifiable session and Supabase unreachable reports signed out without tokens",
  async () => {
    await withAccountProject(
      async (run, sessionPath) => {
        const accessToken = writeFakeSession(sessionPath, { expired: false });
        const result = await run(["whoami"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(NOT_SIGNED_IN);
        expect(result.stdout).not.toContain("Signed in as");
        expectNoSecrets(result, accessToken);
        // Signed-out-by-outage keeps the local session for when Supabase returns.
        expect(existsSync(sessionPath)).toBe(true);
      },
      (proxy) => {
        expect(proxy.requestsTo(SUPABASE_HOST).length).toBeGreaterThan(0);
        expectOnlyHosts(proxy, [SUPABASE_HOST]);
      },
    );
  },
  30_000,
);

test.skipIf(skip)(
  "logout with Supabase unreachable still removes the local session file",
  async () => {
    await withAccountProject(
      async (run, sessionPath) => {
        // Expired token: the refresh retries for ~25 s, then logout must still
        // clear the local session so a user can sign out offline.
        const accessToken = writeFakeSession(sessionPath, { expired: true });
        const result = await run(["logout"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("✅ Signed out");
        expectNoSecrets(result, accessToken);
        expect(existsSync(sessionPath)).toBe(false);
        const whoami = await run(["whoami"]);
        expect(whoami.stdout.trim()).toBe(NOT_SIGNED_IN);
      },
      (proxy) => {
        expect(proxy.requestsTo(SUPABASE_HOST).length).toBeGreaterThan(0);
        expectOnlyHosts(proxy, [SUPABASE_HOST]);
      },
    );
  },
  90_000,
);
