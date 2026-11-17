/**
 * The per-process sandbox cache must be keyed by harness: a batch can select a
 * different harness per task, and the resolved sandbox carries the harness name
 * into the spawn policy (nono pack/state grants, native wrapper, docker agent).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedSandbox, SandboxResolutionOptions } from "@devintern/agent-harness";

const realHarness = { ...(await import("@devintern/agent-harness")) };

const resolveCalls: Array<SandboxResolutionOptions | undefined> = [];
let failFlaky = false;

mock.module("@devintern/agent-harness", () => ({
  ...realHarness,
  resolveSandbox: async (options?: SandboxResolutionOptions): Promise<ResolvedSandbox | null> => {
    resolveCalls.push(options);
    if (!options?.harnessName) return null;
    if (options.harnessName === "flaky" && failFlaky) {
      failFlaky = false;
      throw new Error('Sandbox provider "fake" is not usable on this machine');
    }
    // Mirrors auto: native wraps codex, everything else needs nono.
    const name = options.harnessName === "codex" ? "native" : "nono";
    return {
      provider: {
        name,
        displayName: `${name} sandbox`,
        priority: 1,
        detect: async () => ({ available: true }),
        wrapCommand: () => ({ path: "fake", args: [] }),
      },
      detection: { available: true },
      harnessName: options.harnessName,
    };
  },
}));

const { getSandbox, setSandboxOverride } = await import("../src/lib/agent/sandbox");

beforeEach(() => {
  resolveCalls.length = 0;
  setSandboxOverride("auto");
});

afterAll(() => {
  setSandboxOverride(undefined);
  mock.module("@devintern/agent-harness", () => realHarness);
});

describe("getSandbox", () => {
  test("resolves the sandbox for each harness instead of reusing the first one", async () => {
    const first = await getSandbox("claude-code");
    const second = await getSandbox("goose");

    expect(first?.harnessName).toBe("claude-code");
    expect(second?.harnessName).toBe("goose");
    expect(resolveCalls.map((options) => options?.harnessName)).toEqual(["claude-code", "goose"]);
  });

  test("reuses the resolution for the same harness", async () => {
    const first = await getSandbox("claude-code");
    const second = await getSandbox("claude-code");

    expect(second).toBe(first);
    expect(resolveCalls).toHaveLength(1);
  });

  test("failover onto a harness that needs another provider re-resolves it", async () => {
    const first = await getSandbox("codex");
    const next = await getSandbox("opencode");

    expect(first?.provider.name).toBe("native");
    expect(next?.provider.name).toBe("nono");
    expect(next?.harnessName).toBe("opencode");
  });

  test("a failed resolution is not memoized", async () => {
    failFlaky = true;
    await expect(getSandbox("flaky")).rejects.toThrow("not usable");
    const retried = await getSandbox("flaky");

    expect(retried?.provider.name).toBe("nono");
    expect(resolveCalls.filter((options) => options?.harnessName === "flaky")).toHaveLength(2);
  });
});
