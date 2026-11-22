/**
 * `devintern worker doctor`: the side-effect-free readiness check before
 * starting a worker (`packages/code/src/lib/worker/cli.ts`
 * `runWorkerDoctorSubcommand`, checks in
 * `packages/code/src/lib/observability/worker-readiness.ts`).
 *
 * The readiness collectors are unit-tested in `packages/code`; this suite
 * covers the process surface on a real workspace: config loading, the local
 * bare-remote probe (`git ls-remote`), the license probe failing closed with no
 * session, rendered output, and the exit code. Doctor has no `--json` mode.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerAddResult } from "../../helpers/worker";

const builtCli = existsSync(cliPath);
const NEVER_CRON = "0 0 1 1 *";

function expectFails(result: WorkerAddResult, line: string, hint: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(line);
  expect(result.stdout).toContain(`💡 ${hint}`);
  expect(result.stdout).toContain(
    "❌ Not ready — the worker would sit idle or fail. Fix the checks above.",
  );
}

test.skipIf(!builtCli)(
  "worker doctor passes a valid local workspace and names the failing check otherwise",
  async () => {
    let proxy: RecordingProxy | undefined;
    const worker = new WorkerFixture({
      rootPrefix: "devintern-e2e-worker-doctor-",
      automations: [{ id: "e2e-doctor", cron: NEVER_CRON, prompt: "noop", repo: "fixture" }],
    });
    // A random, credential-shaped value in the workspace .env: doctor reads the
    // file but must never echo a credential value.
    const fakeToken = `ghp_e2eDoctor${crypto.randomUUID().replaceAll("-", "")}`;
    let blocker: ReturnType<typeof Bun.serve> | undefined;
    try {
      proxy = await startRecordingProxy();
      Object.assign(worker.env, proxyEnvironment(proxy.url));
      await worker.prepare();
      const configPath = join(worker.workspaceDir, "workspace.toml");
      writeFileSync(join(worker.workspaceDir, ".env"), `GITHUB_TOKEN=${fakeToken}\n`, {
        mode: 0o600,
      });
      const doctor = async (args: string[] = [], env?: Record<string, string>) => {
        const result = await worker.runCli(["worker", "doctor", ...args], { env });
        for (const output of [result.stdout, result.stderr]) {
          expect(output).not.toContain(fakeToken);
          expect(output).not.toContain(encodeURIComponent(fakeToken));
        }
        return result;
      };

      // (a) Valid workspace: local bare remote, deterministic agent, licensing
      // skipped the way every offline suite does (DEVINTERN_SKIP_LICENSE_CHECK=1).
      const ready = await doctor();
      expect(ready.exitCode).toBe(0);
      expect(ready.stdout).toContain("🩺 devintern worker readiness:");
      for (const line of [
        `✅ Workspace config — 1 repo, 0 teams, 1 automation (${configPath})`,
        "✅ Work sources — 0 tracker querys, 1 automation, 0 error monitors, 1 repo",
        `✅ Repository access — [[repos]] "fixture" (${worker.remote}): remote reachable`,
        "✅ Automation entitlement — license-key",
        "✅ Agent harness — claude-code",
        "✅ Agent sandbox — none (agents run unsandboxed)",
        "✅ Dashboard port — dashboard disabled",
        "✅ Everything looks good — start the worker with `devintern worker`.",
      ]) {
        expect(ready.stdout).toContain(line);
      }
      expect(ready.stdout).not.toContain("❌");
      // Doctor changes nothing: no state database, no lock, no worker.
      expect(existsSync(worker.dbPath)).toBe(false);
      expect(existsSync(worker.lockFile)).toBe(false);

      // --offline skips the repository and license probes as warnings.
      const offline = await doctor(["--offline"]);
      expect(offline.exitCode).toBe(0);
      expect(offline.stdout).toContain("🩺 devintern worker readiness (offline):");
      expect(offline.stdout).toContain(
        `⚠️  Repository access — [[repos]] "fixture" (${worker.remote}): skipped (--offline)`,
      );
      expect(offline.stdout).toContain("⚠️  Automation entitlement — skipped (--offline)");
      expect(offline.stdout).toContain(
        "✅ Ready to run (with the warnings above) — start it with `devintern worker`.",
      );

      // Licensing on, no LICENSE_KEY and no session in the isolated HOME: the
      // entitlement check fails closed without contacting any service.
      const started = performance.now();
      const unlicensed = await doctor([], { DEVINTERN_SKIP_LICENSE_CHECK: "0" });
      const elapsedMs = performance.now() - started;
      expectFails(
        unlicensed,
        "❌ Automation entitlement — none: Automated execution detected (CI / systemd / cron) but no automation license was found.",
        "Run `devintern worker login` to start the free Worker Pilot, or set LICENSE_KEY in the workspace .env (https://devintern.com/pricing)",
      );
      expect(unlicensed.stdout).toContain(
        `✅ Repository access — [[repos]] "fixture" (${worker.remote}): remote reachable`,
      );
      expect(elapsedMs).toBeLessThan(15_000);

      // Doctor has no JSON mode: --json is rejected as an unknown option.
      const json = await doctor(["--json"]);
      expect(json.exitCode).toBe(1);
      expect(json.stdout).toBe("");
      expect(json.stderr).toContain("Unknown option for worker doctor: --json");

      // A busy dashboard port is a warning only.
      blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
      const original = readFileSync(configPath, "utf8");
      writeFileSync(
        configPath,
        original.replace("dashboard = false", `dashboard = true\ndashboard_port = ${blocker.port}`),
      );
      const busy = await doctor();
      expect(busy.exitCode).toBe(0);
      expect(busy.stdout).toContain(
        `⚠️  Dashboard port — 127.0.0.1:${blocker.port} is already in use (another worker or dashboard running?)`,
      );
      writeFileSync(configPath, original);

      // (b) Missing workspace.toml, by --workspace path and by the default location.
      const missingPath = join(worker.root, "missing", "workspace.toml");
      expectFails(
        await doctor(["--workspace", missingPath]),
        `❌ Workspace config — no workspace.toml at ${missingPath}`,
        "Pass --workspace the path of an existing, readable workspace.toml",
      );
      const emptyHome = join(worker.root, "empty-workspace");
      mkdirSync(emptyHome);
      expectFails(
        await doctor([], { DEVINTERN_WORKSPACE_DIR: emptyHome }),
        `❌ Workspace config — no workspace.toml at ${join(emptyHome, "workspace.toml")}`,
        "Run `devintern worker init` (or `devintern worker scaffold`) to create the workspace",
      );

      // (c) A repo whose remote path does not exist.
      const goneRemote = join(worker.root, "gone.git");
      writeFileSync(
        configPath,
        original.replace(`remote = "${worker.remote}"`, `remote = "${goneRemote}"`),
      );
      const noRemote = await doctor();
      expectFails(
        noRemote,
        `❌ Repository access — [[repos]] "fixture" (${goneRemote}): git ls-remote exited 128`,
        'Check the remote URL for "fixture" and that GITHUB_TOKEN (or your git credentials) can read it',
      );
      // Observed: the detail keeps only git's last stderr line ("Please make sure
      // you have the correct access rights\nand the repository exists."), so the
      // cause line ("'…' does not appear to be a git repository") is not shown.
      expect(noRemote.stdout).toContain("git ls-remote exited 128: and the repository exists.");

      // An unparseable workspace.toml names the problem.
      writeFileSync(configPath, "[workspace\n");
      const broken = await doctor();
      expect(broken.exitCode).toBe(1);
      expect(broken.stdout).toMatch(/❌ Workspace config — /);
      expect(broken.stdout).toContain(
        `💡 Edit ${configPath} to fix this entry, then rerun \`devintern worker doctor\``,
      );

      expect(existsSync(worker.dbPath)).toBe(false);
      expect(proxy.requests()).toEqual([]);
    } finally {
      try {
        await blocker?.stop(true);
        await worker.dispose();
      } finally {
        await proxy?.close();
      }
    }
  },
  120_000,
);
