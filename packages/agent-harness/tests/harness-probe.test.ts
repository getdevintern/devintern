import { describe, expect, test } from "bun:test";

import {
  probeHarnessUnderSandbox,
  resetHarnessSandboxProbeCache,
  resolveProbeProvider,
} from "../src/sandbox/harness-probe.js";
import { registerSandboxProvider } from "../src/sandbox/registry.js";
import type { SandboxProvider } from "../src/sandbox/types.js";

function fakeProvider(name: string, script: string): SandboxProvider {
  return {
    name,
    displayName: `${name} (test)`,
    priority: 1,
    detect: async () => ({ available: true }),
    wrapCommand: () => ({
      path: process.execPath,
      args: ["-e", script],
    }),
  };
}

describe("resolveProbeProvider", () => {
  const activeEnv = { NONO_CAP_FILE: process.execPath };

  test("probes directly when a non-nestable provider is already inside a sandbox", async () => {
    const provider = fakeProvider("probe-inherit-kernel", 'console.log("1")');
    registerSandboxProvider(provider);

    const inherited = await resolveProbeProvider(provider.name, { trustedEnv: activeEnv });
    // The next run inherits the enclosing sandbox instead of adding this
    // provider, so the probe must not add its wrapper either.
    expect(inherited).toBeDefined();
    expect(inherited?.name).not.toBe(provider.name);
    expect(
      await inherited?.wrapCommand("/opt/harness/bin/codex", ["--version"], {
        writablePaths: [],
        network: "open",
        workingDir: "/tmp",
      }),
    ).toEqual({ path: "/opt/harness/bin/codex", args: ["--version"] });

    // Outside an enclosing sandbox the same provider is still probed.
    expect(await resolveProbeProvider(provider.name, { trustedEnv: {} })).toBe(provider);
  });

  test("the inherited provider executes the harness instead of the configured wrapper", async () => {
    // The wrapper always succeeds, so only a direct probe can observe that the
    // real path is unusable.
    const provider = fakeProvider("probe-inherit-direct", 'console.log("1")');
    registerSandboxProvider(provider);
    const inherited = await resolveProbeProvider(provider.name, { trustedEnv: activeEnv });
    expect(inherited).toBeDefined();

    const ok = await probeHarnessUnderSandbox({
      path: process.execPath,
      provider: inherited!,
      useCache: false,
    });
    expect(ok).toEqual({ ok: true });

    const missing = await probeHarnessUnderSandbox({
      path: "/nonexistent/devintern-inherited-probe-harness",
      provider: inherited!,
      useCache: false,
    });
    expect(missing.ok).toBe(false);
  });

  test("still returns a nesting-capable provider inside a sandbox", async () => {
    const provider: SandboxProvider = {
      ...fakeProvider("probe-inherit-vm", 'console.log("1")'),
      canNestInSandbox: true,
    };
    registerSandboxProvider(provider);

    expect(await resolveProbeProvider(provider.name, { trustedEnv: activeEnv })).toBe(provider);
  });

  test("returns the configured provider when it cannot wrap the requested harness", async () => {
    // `resolveSandbox` throws for this combination before any nesting decision,
    // so probing through the inherited stand-in would hide a next run that fails.
    const provider: SandboxProvider = {
      ...fakeProvider("probe-inherit-incompatible", 'console.log("1")'),
      supportsHarness: (harnessName) => harnessName === "claude-code",
    };
    registerSandboxProvider(provider);

    expect(
      await resolveProbeProvider(provider.name, {
        trustedEnv: activeEnv,
        harnessName: "grok",
      }),
    ).toBe(provider);
  });

  test("the inherited provider reports the configured provider's harness support", async () => {
    const provider: SandboxProvider = {
      ...fakeProvider("probe-inherit-compat", 'console.log("1")'),
      supportsHarness: (harnessName) => harnessName === "claude-code",
    };
    registerSandboxProvider(provider);

    const inherited = await resolveProbeProvider(provider.name, {
      trustedEnv: activeEnv,
      harnessName: "claude-code",
    });
    expect(inherited?.name).toBe("nono (inherited)");
    expect(inherited?.supportsHarness?.("claude-code")).toBe(true);
    expect(inherited?.supportsHarness?.("grok")).toBe(false);
  });

  test("auto probes directly when already inside a sandbox", async () => {
    // `resolveSandbox` returns null for `auto` inside an enclosing sandbox
    // before any detection, so the next run always inherits that confinement.
    // The probe must therefore run the harness unwrapped, not be skipped.
    const inherited = await resolveProbeProvider("auto", { trustedEnv: activeEnv });
    expect(inherited).toBeDefined();
    expect(inherited?.name).toBe("nono (inherited)");
    expect(
      await inherited?.wrapCommand("/opt/harness/bin/codex", ["--version"], {
        writablePaths: [],
        network: "open",
        workingDir: "/tmp",
      }),
    ).toEqual({ path: "/opt/harness/bin/codex", args: ["--version"] });
  });

  test("unknown names and none never resolve", async () => {
    expect(await resolveProbeProvider("none", { trustedEnv: {} })).toBeUndefined();
    expect(await resolveProbeProvider("probe-does-not-exist", { trustedEnv: {} })).toBeUndefined();
  });
});

describe("probeHarnessUnderSandbox", () => {
  test("reports ok when the wrapped harness version command succeeds", async () => {
    resetHarnessSandboxProbeCache();
    const result = await probeHarnessUnderSandbox({
      path: "/fake/harness",
      provider: fakeProvider("probe-ok", 'console.log("1.2.3")'),
      useCache: false,
    });
    expect(result).toEqual({ ok: true });
  });

  test("returns the first actionable stderr line on failure", async () => {
    resetHarnessSandboxProbeCache();
    const result = await probeHarnessUnderSandbox({
      path: "/fake/harness",
      provider: fakeProvider(
        "probe-fail",
        'console.error("mise ERROR Failed to install npm:x: Permission denied"); process.exit(1)',
      ),
      useCache: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("mise ERROR");
      expect(result.reason).toContain("Permission denied");
    }
  });

  test("times out a hung harness", async () => {
    resetHarnessSandboxProbeCache();
    const result = await probeHarnessUnderSandbox({
      path: "/fake/harness",
      provider: fakeProvider("probe-timeout", "setTimeout(() => {}, 5000)"),
      timeoutMs: 50,
      useCache: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("timed out");
    }
  });

  test("caches results per path and provider until reset", async () => {
    resetHarnessSandboxProbeCache();
    let calls = 0;
    const provider = fakeProvider("probe-cache", 'console.log("1")');
    const originalWrap = provider.wrapCommand.bind(provider);
    provider.wrapCommand = (path, args, policy) => {
      calls++;
      return originalWrap(path, args, policy);
    };

    const options = { path: "/fake/cached-harness", provider } as const;
    await probeHarnessUnderSandbox(options);
    await probeHarnessUnderSandbox(options);
    expect(calls).toBe(1);

    resetHarnessSandboxProbeCache("/fake/cached-harness");
    await probeHarnessUnderSandbox(options);
    expect(calls).toBe(2);
  });
});
