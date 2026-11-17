/**
 * Proves the built CLI's privacy opt-outs mean zero egress, and that the
 * enabled paths really reach the expected hosts.
 *
 * Every child runs with `HTTP(S)_PROXY` pointed at a loopback recording proxy
 * that refuses every tunnel, so nothing leaves the machine; the test asserts
 * only on the hosts the CLI tried to reach. `devintern doctor` is the probe
 * command: it runs the startup update check and tracks `doctor_run`, then
 * flushes analytics before exiting.
 *
 * - Telemetry: `DEVINTERN_TELEMETRY_DISABLED` and `analytics.enabled: false`
 *   in `<DEVINTERN_ANALYTICS_CONFIG_DIR>/settings.json` (packages/code/src/lib/observability/analytics.ts).
 * - Update check: `DEVINTERN_NO_UPDATE=1` and `--no-update`
 *   (packages/utils/src/cli-auto-update.ts). The check only runs for global
 *   installs, so those cases copy `dist/` into a Bun global install layout
 *   under the temp HOME.
 */

import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { cliPath } from "../../helpers/fixture-workspace";
import type { CommandResult } from "../../helpers/process";
import { command } from "../../helpers/process";
import type { RecordingProxy } from "../../helpers/recording-proxy";
import { proxyEnvironment, startRecordingProxy } from "../../helpers/recording-proxy";

const skip = !existsSync(cliPath);

/**
 * `packages/code/build.ts` bakes `__POSTHOG_HOST__` (default
 * `https://us.i.posthog.com`); a runtime `POSTHOG_HOST` is ignored by the
 * built CLI. Set `E2E_POSTHOG_HOST` when testing a build with another host.
 */
const POSTHOG_HOST = new URL(process.env.E2E_POSTHOG_HOST?.trim() || "https://us.i.posthog.com")
  .hostname;
const NPM_REGISTRY_HOST = "registry.npmjs.org";
/** Fake key: used only when the build baked none; the proxy refuses the send. */
const FAKE_POSTHOG_API_KEY = "phc_e2e_fake_key_not_real";

interface PrivacyFixture {
  root: string;
  cwd: string;
  proxy: RecordingProxy;
  /** `DEVINTERN_ANALYTICS_CONFIG_DIR`: holds settings.json and telemetry.json. */
  analyticsDir: string;
  /** Run `doctor` with the given env overrides (`undefined` deletes a key). */
  doctor: (
    args?: string[],
    overrides?: Record<string, string | undefined>,
    script?: string,
  ) => Promise<CommandResult>;
  /** Copy the built CLI into a Bun global install under HOME; returns its script path. */
  installGlobalCopy: () => string;
}

/**
 * Temp HOME/config/cwd, Markdown tracker and fake agent so doctor is healthy,
 * plus a dedicated recording proxy. Telemetry and update checks start in the
 * isolated defaults (disabled); each case re-enables only what it exercises.
 */
async function createFixture(): Promise<PrivacyFixture> {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-privacy-"));
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const tasks = join(root, "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, "fixture.md"), "# Privacy fixture\n\nA local Markdown task.\n");
  const agent = join(root, "bin", "agent.ts");
  mkdirSync(dirname(agent), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "../../helpers/fake-agent.ts"), agent);
  chmodSync(agent, 0o700);

  let proxy: RecordingProxy;
  try {
    proxy = await startRecordingProxy();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const base = isolatedEnvironment(root);
  const env: Record<string, string> = {
    ...base,
    MARKDOWN_TASKS_DIR: tasks,
    AGENT_CLI_PATH: agent,
    NO_COLOR: "1",
    E2E_AGENT_INVOCATIONS: join(root, "agent-invocations.jsonl"),
    POSTHOG_API_KEY: FAKE_POSTHOG_API_KEY,
    ...proxyEnvironment(proxy.url),
  };

  return {
    root,
    cwd,
    proxy,
    analyticsDir: base.DEVINTERN_ANALYTICS_CONFIG_DIR,
    doctor: (args = [], overrides = {}, script = cliPath) => {
      const childEnv: Record<string, string> = { ...env };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = value;
      }
      return command([process.execPath, script, "doctor", ...args], cwd, childEnv, 60_000);
    },
    installGlobalCopy: () => {
      // Real file copy, not a symlink: install detection follows symlinks,
      // and a path under packages/code is classified as a source checkout.
      const packageDir = join(base.HOME, ".bun/install/global/node_modules/@getdevintern/code");
      cpSync(dirname(cliPath), join(packageDir, "dist"), { recursive: true });
      return join(packageDir, "dist", "index.js");
    },
  };
}

/** Run a scenario, then close the proxy and remove the temp root even on failure. */
async function withFixture(scenario: (fixture: PrivacyFixture) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  const failures: string[] = [];
  try {
    await scenario(fixture);
  } finally {
    try {
      await fixture.proxy.close();
    } catch (error) {
      failures.push(`proxy: ${String(error)}`);
    }
    try {
      rmSync(fixture.root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`temp root ${fixture.root}: ${String(error)}`);
    }
    if (failures.length > 0) console.warn(`cleanup incomplete: ${failures.join("; ")}`);
  }
}

/** Telemetry on: unset kill-switch; update check off so only analytics can egress. */
const TELEMETRY_ON = { DEVINTERN_TELEMETRY_DISABLED: undefined, DEVINTERN_NO_UPDATE: "1" };

/** Doctor's healthy result must be unchanged by refused telemetry/update traffic. */
function expectHealthyDoctor(result: CommandResult): void {
  const text = `${result.stdout}\n${result.stderr}`;
  expect(result.exitCode).toBe(0);
  expect(text).toContain("⚠️  Ready but degraded — review the warnings above.");
}

/** Recorded target hosts only; never request contents. */
function hosts(proxy: RecordingProxy): string[] {
  return proxy.requests().map((request) => request.host);
}

function readTelemetry(fixture: PrivacyFixture): {
  anonymousId?: string;
  optOutReported?: boolean;
} {
  return JSON.parse(readFileSync(join(fixture.analyticsDir, "telemetry.json"), "utf8"));
}

function writeAnalyticsOptOut(fixture: PrivacyFixture): void {
  mkdirSync(fixture.analyticsDir, { recursive: true });
  writeFileSync(
    join(fixture.analyticsDir, "settings.json"),
    `${JSON.stringify({ analytics: { enabled: false } }, null, 2)}\n`,
  );
}

test.skipIf(skip)(
  "sensitivity: enabled telemetry reaches the baked PostHog host through the proxy without failing the run",
  async () => {
    await withFixture(async (fixture) => {
      const result = await fixture.doctor([], TELEMETRY_ON);

      expectHealthyDoctor(result);
      expect(fixture.proxy.requestsTo(POSTHOG_HOST).length).toBeGreaterThan(0);
      expect(fixture.proxy.requestsTo(POSTHOG_HOST).every((r) => r.method === "CONNECT")).toBe(
        true,
      );
      // Nothing else egressed: no update check, Sentry, or license traffic.
      expect(new Set(hosts(fixture.proxy))).toEqual(new Set([POSTHOG_HOST]));
      expect(readTelemetry(fixture).anonymousId).toBeString();
    });
  },
  60_000,
);

test.skipIf(skip)(
  "DEVINTERN_TELEMETRY_DISABLED=1 makes zero network requests",
  async () => {
    await withFixture(async (fixture) => {
      for (const value of ["1", "true"]) {
        fixture.proxy.reset();
        const result = await fixture.doctor([], {
          ...TELEMETRY_ON,
          DEVINTERN_TELEMETRY_DISABLED: value,
        });
        expectHealthyDoctor(result);
        expect(hosts(fixture.proxy)).toEqual([]);
      }
      // The kill-switch also skips creating the anonymous id.
      expect(existsSync(join(fixture.analyticsDir, "telemetry.json"))).toBe(false);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "an empty or zero DEVINTERN_TELEMETRY_DISABLED does not opt out (documented contract: truthy values only)",
  async () => {
    // isTelemetryDisabledByEnv treats "" and "0" as unset; the unit test in
    // packages/code/tests/analytics.test.ts pins the same contract.
    await withFixture(async (fixture) => {
      for (const value of ["", "0"]) {
        fixture.proxy.reset();
        const result = await fixture.doctor([], {
          ...TELEMETRY_ON,
          DEVINTERN_TELEMETRY_DISABLED: value,
        });
        expectHealthyDoctor(result);
        expect(fixture.proxy.requestsTo(POSTHOG_HOST).length).toBeGreaterThan(0);
      }
    });
  },
  60_000,
);

test.skipIf(skip)(
  "analytics.enabled=false in a fresh config dir makes zero network requests across runs",
  async () => {
    await withFixture(async (fixture) => {
      writeAnalyticsOptOut(fixture);
      for (let run = 0; run < 2; run++) {
        fixture.proxy.reset();
        const result = await fixture.doctor([], TELEMETRY_ON);
        expectHealthyDoctor(result);
        expect(hosts(fixture.proxy)).toEqual([]);
      }
      // No prior anonymous id, so no one-time opt-out event and no id is minted.
      expect(existsSync(join(fixture.analyticsDir, "telemetry.json"))).toBe(false);
    });
  },
  60_000,
);

test.skipIf(skip)(
  "opting out after an enabled run sends the one-time analytics_opt_out once, then nothing",
  async () => {
    await withFixture(async (fixture) => {
      expectHealthyDoctor(await fixture.doctor([], TELEMETRY_ON));
      expect(fixture.proxy.requestsTo(POSTHOG_HOST).length).toBeGreaterThan(0);
      const { anonymousId } = readTelemetry(fixture);
      expect(anonymousId).toBeString();

      writeAnalyticsOptOut(fixture);

      // First opted-out run: the documented acknowledgement goes to PostHog
      // and is marked in telemetry.json even though the proxy refused it.
      fixture.proxy.reset();
      expectHealthyDoctor(await fixture.doctor([], TELEMETRY_ON));
      expect(fixture.proxy.requestsTo(POSTHOG_HOST).length).toBeGreaterThan(0);
      expect(new Set(hosts(fixture.proxy))).toEqual(new Set([POSTHOG_HOST]));
      expect(readTelemetry(fixture)).toEqual({ anonymousId, optOutReported: true });

      // Every later run is silent.
      fixture.proxy.reset();
      expectHealthyDoctor(await fixture.doctor([], TELEMETRY_ON));
      expect(hosts(fixture.proxy)).toEqual([]);
      expect(readTelemetry(fixture)).toEqual({ anonymousId, optOutReported: true });
    });
  },
  90_000,
);

test.skipIf(skip)(
  "the env kill-switch suppresses even the one-time opt-out acknowledgement",
  async () => {
    await withFixture(async (fixture) => {
      expectHealthyDoctor(await fixture.doctor([], TELEMETRY_ON));
      const { anonymousId } = readTelemetry(fixture);
      writeAnalyticsOptOut(fixture);

      fixture.proxy.reset();
      const result = await fixture.doctor([], {
        ...TELEMETRY_ON,
        DEVINTERN_TELEMETRY_DISABLED: "1",
      });
      expectHealthyDoctor(result);
      expect(hosts(fixture.proxy)).toEqual([]);
      expect(readTelemetry(fixture)).toEqual({ anonymousId });
    });
  },
  90_000,
);

test.skipIf(skip)(
  "the update check contacts the npm registry from a global install and is silenced by DEVINTERN_NO_UPDATE=1 and --no-update",
  async () => {
    await withFixture(async (fixture) => {
      // Telemetry stays disabled so the registry is the only possible egress.
      const updateOn = { DEVINTERN_NO_UPDATE: undefined };
      const globalCli = fixture.installGlobalCopy();

      // Sensitivity: a global install checks npm (a fresh HOME has no cache).
      const enabled = await fixture.doctor([], updateOn, globalCli);
      expectHealthyDoctor(enabled);
      expect(fixture.proxy.requestsTo(NPM_REGISTRY_HOST).length).toBeGreaterThan(0);
      expect(new Set(hosts(fixture.proxy))).toEqual(new Set([NPM_REGISTRY_HOST]));
      // Drop the update cache so the opted-out runs would be due for a check
      // if the opt-outs were ignored.
      rmSync(join(fixture.root, "home", ".devintern", "update-check.json"), { force: true });

      for (const [label, args, overrides] of [
        ["DEVINTERN_NO_UPDATE=1", [], { DEVINTERN_NO_UPDATE: "1" }],
        ["--no-update", ["--no-update"], updateOn],
      ] as const) {
        fixture.proxy.reset();
        const result = await fixture.doctor([...args], { ...overrides }, globalCli);
        expectHealthyDoctor(result);
        expect({ label, hosts: hosts(fixture.proxy) }).toEqual({ label, hosts: [] });
      }

      // A source-checkout build (packages/code/dist) never checks for updates.
      fixture.proxy.reset();
      expectHealthyDoctor(await fixture.doctor([], updateOn));
      expect(hosts(fixture.proxy)).toEqual([]);
    });
  },
  90_000,
);
