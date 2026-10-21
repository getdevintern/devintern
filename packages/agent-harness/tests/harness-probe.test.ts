import { describe, expect, test } from "bun:test";

import {
  probeHarnessUnderSandbox,
  resetHarnessSandboxProbeCache,
} from "../src/sandbox/harness-probe.js";
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
