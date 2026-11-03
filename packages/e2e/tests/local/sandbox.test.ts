/**
 * End-to-end coverage for sandbox provider selection and fail-closed behavior.
 *
 * These tests exercise the built CLI. Real boundary checks run when the
 * relevant provider can actually start on this host; fail-closed and doctor
 * checks are deterministic and run without any external provider by removing
 * its executable from PATH (or shadowing it with an unreachable daemon stub).
 *
 * The suite complements the agent-harness unit tests, which only inspect the
 * generated argv. No AI account or model call is involved.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cliPath } from "../../helpers/fixture-workspace";
import type { CommandResult } from "../../helpers/process";
import { command } from "../../helpers/process";
import {
  createProviderHome,
  createSandboxHome,
  nonoPath,
  pathWithoutProvider,
  providerBinary,
  providerPrerequisite,
  runtimeBinDir,
  SandboxWorkspace,
  sandboxEnvironment,
  stubExecutable,
  stubHarness,
} from "../../helpers/sandbox";

const nono = nonoPath();
const skip = !existsSync(cliPath) || nono === undefined;

/** PATH with the provider's executable removed, keeping runtime and system tools. */
function providerOfflineEnv(provider: string): Record<string, string> {
  return { PATH: [runtimeBinDir(), pathWithoutProvider(provider)].join(delimiter) };
}

/** PATH with a stub executable shadowing the real one, for unreachable services. */
function shadowBinEnv(run: SandboxWorkspace, name: string, source: string): Record<string, string> {
  const bin = join(run.root, "shadow-bin");
  mkdirSync(bin, { recursive: true });
  stubExecutable(bin, name, source);
  return { PATH: [bin, runtimeBinDir(), process.env.PATH ?? ""].join(delimiter) };
}

/** PATH with stub harness CLIs so provider preflight does not need real agents. */
function stubHarnessEnv(run: SandboxWorkspace, names: readonly string[]): Record<string, string> {
  const bin = join(run.root, "harness-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) stubHarness(bin, name);
  return { PATH: [bin, runtimeBinDir(), process.env.PATH ?? ""].join(delimiter) };
}

/** A stub `sbx` whose `ls` fails, matching an unreachable/unauthenticated daemon. */
const DOCKER_DAEMON_DOWN_STUB = `#!/bin/sh
case "$1" in
  ls) echo "Not authenticated to Docker" >&2; exit 1 ;;
  *) echo "stub"; exit 0 ;;
esac
`;

/** Assert an explicitly requested provider aborted the run before the agent. */
async function expectFailClosed(
  run: SandboxWorkspace,
  result: CommandResult,
  provider: string,
  wording: string,
): Promise<void> {
  const text = `${result.stdout}\n${result.stderr}`;
  expect(result.exitCode).not.toBe(0);
  expect(text).toContain(`Sandbox provider "${provider}"`);
  expect(text).toContain(wording);
  expect(text).not.toContain("🔒 Agent sandbox:");
  // Nothing ran: no probe report, no commit, no pushed branch.
  expect(Object.keys(run.checks())).toHaveLength(0);
  expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
  expect(await run.remoteSha(run.head)).toBeUndefined();
}

test.skipIf(skip)(
  "sandbox doctor reports nono as available and what the next run does",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-"));
    const home = createSandboxHome();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    stubHarness(bin, "goose");
    const baseEnv = sandboxEnvironment(root, home);
    const env = {
      ...baseEnv,
      PATH: [bin, runtimeBinDir(), baseEnv.PATH].join(delimiter),
    };
    try {
      const explicit = await command([process.execPath, cliPath, "sandbox"], root, env);
      const explicitText = `${explicit.stdout}\n${explicit.stderr}`;
      expect(explicit.exitCode).toBe(0);
      expect(explicitText).toContain("Configured: AGENT_SANDBOX=nono");
      expect(explicitText).toContain("Next run:   agent wrapped with nono (kernel sandbox)");
      expect(explicitText).toContain("✅ available");
      expect(explicitText).toContain("Harness CLI preflight (nono)");
      expect(explicitText).toContain("claude");
      expect(explicitText).not.toContain("FAIL —");

      // `auto` must pick nono for a harness without a built-in sandbox
      // (native only covers claude-code and codex).
      const automatic = await command([process.execPath, cliPath, "sandbox"], root, {
        ...env,
        AGENT_SANDBOX: "auto",
        AGENT_HARNESS: "goose",
      });
      const automaticText = `${automatic.stdout}\n${automatic.stderr}`;
      expect(automatic.exitCode).toBe(0);
      expect(automaticText).toContain("auto picks nono");
      expect(automaticText).toContain("AGENT_SANDBOX=auto would pick: nono");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(skip)(
  "a nono-wrapped agent writes inside the granted paths and cannot escape into HOME",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    try {
      const result = await run.run();
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("🔒 Agent sandbox: nono (kernel sandbox)");

      const checks = run.checks();
      expect(checks["nono-marker"]?.ok).toBe(true);
      expect(checks["working-dir-write"]?.ok).toBe(true);
      expect(checks["temp-write"]?.ok).toBe(true);
      expect(checks["output-write"]?.ok).toBe(true);
      expect(checks["repo-edit"]?.ok).toBe(true);
      // The v1 policy keeps reads open but confines writes.
      expect(checks["home-read"]?.ok).toBe(true);
      expect(checks["home-write"]?.ok).toBe(false);
      expect(checks["outside-write"]?.ok).toBe(false);
      expect(existsSync(join(run.home, "sandbox-escape"))).toBe(false);
      expect(existsSync(join(run.outside, "sandbox-escape"))).toBe(false);

      expect(await run.git("branch", "--show-current")).toBe(run.head);
      expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
      expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await run.git("status", "--porcelain")).toBe("");
      expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
    } finally {
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "an explicitly requested nono provider fails closed when nono is unavailable",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    try {
      const result = await run.run({
        PATH: [runtimeBinDir(), pathWithoutProvider("nono")].join(delimiter),
      });
      await expectFailClosed(run, result, "nono", "not usable on this machine");
    } finally {
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(skip)(
  "an enclosing nono sandbox is inherited instead of nested",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    const marker = join(run.root, "nono-cap.json");
    writeFileSync(marker, "{}");
    try {
      const result = await run.run({ NONO_CAP_FILE: marker });
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("Already running inside the nono sandbox");

      // HOME is writable because no second sandbox was applied, proving the
      // run inherited the enclosing confinement rather than stacking nono.
      const checks = run.checks();
      expect(checks["home-write"]?.ok).toBe(true);
      expect(checks["repo-edit"]?.ok).toBe(true);
      expect(await run.git("branch", "--show-current")).toBe(run.head);
    } finally {
      run.dispose();
    }
  },
  90_000,
);

// Explicit providers that cannot be enforced must abort before the agent runs.
for (const provider of ["srt", "smolvm", "docker"] as const) {
  test.skipIf(!existsSync(cliPath))(
    `an explicitly requested ${provider} provider fails closed when it is unusable`,
    async () => {
      const run = await new SandboxWorkspace().prepare();
      try {
        // docker runs as `sbx`; shadowing it with a failing daemon keeps the
        // system PATH (including git and sh) intact.
        const overrides =
          provider === "docker"
            ? shadowBinEnv(run, providerBinary("docker") ?? "sbx", DOCKER_DAEMON_DOWN_STUB)
            : providerOfflineEnv(provider);
        const result = await run.run(overrides, ["--sandbox", provider]);
        await expectFailClosed(run, result, provider, "not usable on this machine");
      } finally {
        run.dispose();
      }
    },
    90_000,
  );
}

test.skipIf(!existsSync(cliPath))(
  "an explicitly requested native provider fails closed for a harness it cannot wrap",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    try {
      const result = await run.run({ ...stubHarnessEnv(run, ["goose"]), AGENT_HARNESS: "goose" }, [
        "--sandbox",
        "native",
      ]);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      expect(text).toContain('Sandbox provider "native" does not support the "goose" harness');
      expect(text).not.toContain("🔒 Agent sandbox:");
      expect(Object.keys(run.checks())).toHaveLength(0);
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
      expect(await run.remoteSha(run.head)).toBeUndefined();
    } finally {
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "an unknown --sandbox provider fails closed without running the agent",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    try {
      // AGENT_SANDBOX is nono for this workspace; the flag must override it.
      const result = await run.run({}, ["--sandbox", "bogus"]);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      expect(text).toContain('Unknown sandbox provider: "bogus"');
      expect(text).toContain("Valid values:");
      expect(text).toContain('"none"');
      expect(text).toContain('"auto"');
      expect(text).not.toContain("🔒 Agent sandbox:");
      expect(Object.keys(run.checks())).toHaveLength(0);
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
      expect(await run.remoteSha(run.head)).toBeUndefined();
    } finally {
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor fails closed for an unknown AGENT_SANDBOX value",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-bogus-"));
    const home = createProviderHome(root);
    try {
      const result = await command(
        [process.execPath, cliPath, "sandbox"],
        root,
        sandboxEnvironment(root, home, "bogus"),
      );
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(1);
      expect(text).toContain("Configured: AGENT_SANDBOX=bogus");
      expect(text).toContain('unknown provider "bogus"');
      expect(text).toContain("❌ fails");
      expect(text).toContain("Valid: none, auto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor reports the native provider as the next run for a supported harness",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-native-"));
    const home = createProviderHome(root);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    stubHarness(bin, "codex");
    const baseEnv = sandboxEnvironment(root, home, "native");
    const env = {
      ...baseEnv,
      PATH: [bin, runtimeBinDir(), baseEnv.PATH].join(delimiter),
      AGENT_HARNESS: "claude-code",
    };
    try {
      const result = await command([process.execPath, cliPath, "sandbox"], root, env);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("Configured: AGENT_SANDBOX=native");
      expect(text).toContain("Next run:   agent wrapped with Harness native sandbox");
      expect(text).toContain("✅ available");
      expect(text).toContain("Harness CLI preflight (native)");
      expect(text).toContain("AGENT_SANDBOX=auto would pick: native");
      expect(text).not.toContain("❌ fails");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor reports srt availability honestly without crashing",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-srt-"));
    const home = createProviderHome(root);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    const baseEnv = sandboxEnvironment(root, home, "srt");
    const env = {
      ...baseEnv,
      PATH: [bin, runtimeBinDir(), baseEnv.PATH].join(delimiter),
      AGENT_HARNESS: "claude-code",
    };
    try {
      const result = await command([process.execPath, cliPath, "sandbox"], root, env);
      const text = `${result.stdout}\n${result.stderr}`;
      // Available with a failing preflight and unavailable both exit non-zero.
      expect([0, 1]).toContain(result.exitCode);
      expect(text).toContain("Configured: AGENT_SANDBOX=srt");
      expect(text).toMatch(/srt\s+Anthropic Sandbox Runtime/);
      expect(text).toMatch(/✅ available|❌ srt not found on PATH/);
      expect(text).not.toContain("Uncaught exception");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor reports smolvm as unavailable when its binary is missing",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-smolvm-"));
    const home = createProviderHome(root);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    const baseEnv = sandboxEnvironment(root, home, "smolvm");
    const env = {
      ...baseEnv,
      // Removing the binary avoids booting a microVM (and downloading an
      // image) just to render the doctor report.
      PATH: [bin, runtimeBinDir(), pathWithoutProvider("smolvm")].join(delimiter),
      AGENT_HARNESS: "claude-code",
    };
    try {
      const result = await command([process.execPath, cliPath, "sandbox"], root, env);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(1);
      expect(text).toContain("Configured: AGENT_SANDBOX=smolvm");
      expect(text).toMatch(/smolvm\s+SmolVM \(microVM\)/);
      expect(text).toContain("smolvm is not usable on this machine");
      expect(text).toContain("smolvm not found on PATH");
      expect(text).not.toContain("agent wrapped with SmolVM");
      expect(text).not.toContain("Uncaught exception");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor does not claim docker sandboxes a run when the daemon is unreachable",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-docker-"));
    const home = createProviderHome(root);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    const sbx = providerBinary("docker") ?? "sbx";
    const shadow = join(home, "shadow");
    mkdirSync(shadow, { recursive: true });
    stubExecutable(shadow, sbx, DOCKER_DAEMON_DOWN_STUB);
    const baseEnv = sandboxEnvironment(root, home, "docker");
    const env = {
      ...baseEnv,
      PATH: [shadow, bin, runtimeBinDir(), baseEnv.PATH].join(delimiter),
      AGENT_HARNESS: "claude-code",
    };
    try {
      const result = await command([process.execPath, cliPath, "sandbox"], root, env);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(1);
      expect(text).toContain("Configured: AGENT_SANDBOX=docker");
      expect(text).toMatch(/docker\s+Docker Sandboxes \(microVM\)/);
      expect(text).toContain("docker is not usable on this machine");
      expect(text).toContain("sbx found, but not usable");
      expect(text).not.toContain("agent wrapped with Docker Sandboxes");
      expect(text).not.toContain("Uncaught exception");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor picks native for auto when the harness supports it",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-auto-native-"));
    const home = createProviderHome(root);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    stubHarness(bin, "codex");
    const baseEnv = sandboxEnvironment(root, home, "auto");
    const env = {
      ...baseEnv,
      PATH: [bin, runtimeBinDir(), baseEnv.PATH].join(delimiter),
      AGENT_HARNESS: "claude-code",
    };
    try {
      const result = await command([process.execPath, cliPath, "sandbox"], root, env);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("Configured: AGENT_SANDBOX=auto");
      expect(text).toContain("auto picks native");
      expect(text).toContain("agent wrapped with Harness native sandbox");
      expect(text).toContain("AGENT_SANDBOX=auto would pick: native");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "sandbox doctor reports a missing harness CLI and fails the next run",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-missing-"));
    const home = createProviderHome(root);
    const baseEnv = sandboxEnvironment(root, home, "native");
    const env = {
      ...baseEnv,
      // An explicit but nonexistent path exercises the missing-harness preflight
      // without deleting a whole system PATH directory that may hold other tools.
      CLAUDE_CLI_PATH: join(root, "missing-harness", "claude"),
      AGENT_HARNESS: "claude-code",
    };
    try {
      const result = await command([process.execPath, cliPath, "sandbox"], root, env);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(1);
      expect(text).toContain("Harness CLI preflight (native)");
      expect(text).toContain("FAIL —");
      expect(text).toContain("CLAUDE_CLI_PATH");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

// Optional real boundary. srt can wrap an arbitrary process, so the shell probe
// works unchanged. It is skip-gated on the provider actually starting: srt
// inside another OS sandbox (or without bwrap namespaces) cannot, and a failed
// start is an environment prerequisite, not a product regression.
const srtPrerequisite = providerPrerequisite("srt");

test.skipIf(!existsSync(cliPath) || !srtPrerequisite.usable)(
  "a srt-wrapped agent writes inside the granted paths and cannot escape",
  async () => {
    const run = await new SandboxWorkspace({ provider: "srt" }).prepare();
    try {
      const result = await run.run({}, ["--sandbox", "srt"]);
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("🔒 Agent sandbox: Anthropic Sandbox Runtime (srt)");

      const checks = run.checks();
      expect(checks["working-dir-write"]?.ok).toBe(true);
      expect(checks["temp-write"]?.ok).toBe(true);
      expect(checks["output-write"]?.ok).toBe(true);
      expect(checks["repo-edit"]?.ok).toBe(true);
      expect(checks["home-write"]?.ok).toBe(false);
      expect(checks["outside-write"]?.ok).toBe(false);
      expect(existsSync(join(run.home, "sandbox-escape"))).toBe(false);
      expect(existsSync(join(run.outside, "sandbox-escape"))).toBe(false);

      expect(await run.git("branch", "--show-current")).toBe(run.head);
      expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
      expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
    } finally {
      run.dispose();
    }
  },
  120_000,
);
