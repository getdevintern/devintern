/**
 * The per-process sandbox cache must be keyed by harness: a batch can select a
 * different harness per task, and the resolved sandbox carries the harness name
 * into the spawn policy (nono pack/state grants, native wrapper, docker agent).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedSandbox, SandboxResolutionOptions } from "@devintern/agent-harness";

const realHarness = { ...(await import("@devintern/agent-harness")) };

const resolveCalls: Array<SandboxResolutionOptions | undefined> = [];

mock.module("@devintern/agent-harness", () => ({
  ...realHarness,
  resolveSandbox: async (options?: SandboxResolutionOptions): Promise<ResolvedSandbox | null> => {
    resolveCalls.push(options);
    if (!options?.harnessName) return null;
    return {
      provider: {
        name: "fake",
        displayName: "Fake sandbox",
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
});
