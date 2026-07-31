import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DetectedSandboxProvider } from "../src/sandbox/detect.js";
import { registerSandboxProvider } from "../src/sandbox/registry.js";
import { resolveSandbox } from "../src/sandbox/resolver.js";
import type {
  SandboxDetection,
  SandboxPolicy,
  SandboxProvider,
  WrappedCommand,
} from "../src/sandbox/types.js";

function makeProvider(
  name: string,
  overrides: Partial<Pick<SandboxProvider, "priority" | "supportsHarness">> & {
    available?: boolean;
    reason?: string;
  } = {},
): SandboxProvider {
  return {
    name,
    displayName: name,
    priority: overrides.priority ?? 10,
    supportsHarness: overrides.supportsHarness,
    detect: async (): Promise<SandboxDetection> => ({
      available: overrides.available ?? true,
      reason: overrides.reason,
    }),
    wrapCommand: (path: string, args: readonly string[], _policy: SandboxPolicy): WrappedCommand => ({
      path: name,
      args: [path, ...args],
    }),
  };
}

function detectionsOf(...providers: SandboxProvider[]): Promise<DetectedSandboxProvider[]> {
  return Promise.all(providers.map(async (provider) => ({ provider, detection: await provider.detect() })));
}

describe("resolveSandbox", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AGENT_SANDBOX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('defaults to "none" → null (unsandboxed, backward compatible)', async () => {
    expect(await resolveSandbox()).toBeNull();
  });

  test('explicit "none" → null even when AGENT_SANDBOX is set', async () => {
    process.env.AGENT_SANDBOX = "auto";
    expect(await resolveSandbox({ sandboxName: "none", detections: [] })).toBeNull();
  });

  test("options.sandboxName takes precedence over AGENT_SANDBOX", async () => {
    process.env.AGENT_SANDBOX = "definitely-not-registered";
    expect(await resolveSandbox({ sandboxName: "none" })).toBeNull();
  });

  test("throws for unknown provider name", async () => {
    expect(resolveSandbox({ sandboxName: "bogus", detections: [] })).rejects.toThrow(
      "Unknown sandbox provider",
    );
  });

  test("auto picks the highest-priority available provider", async () => {
    const low = makeProvider("fake-low", { priority: 5 });
    const high = makeProvider("fake-high", { priority: 50 });
    const unavailable = makeProvider("fake-unavailable", { priority: 100, available: false });
    const resolved = await resolveSandbox({
      sandboxName: "auto",
      detections: await detectionsOf(low, high, unavailable),
    });
    expect(resolved?.provider.name).toBe("fake-high");
  });

  test("auto skips providers that do not support the harness", async () => {
    const picky = makeProvider("fake-picky", {
      priority: 50,
      supportsHarness: (h) => h === "codex",
    });
    const universal = makeProvider("fake-universal", { priority: 5 });
    const resolved = await resolveSandbox({
      sandboxName: "auto",
      harnessName: "opencode",
      detections: await detectionsOf(picky, universal),
    });
    expect(resolved?.provider.name).toBe("fake-universal");
  });

  test("auto skips priority-0 (explicit-only) providers", async () => {
    const explicitOnly = makeProvider("fake-explicit-only", { priority: 0 });
    const warnings: string[] = [];
    const resolved = await resolveSandbox({
      sandboxName: "auto",
      detections: await detectionsOf(explicitOnly),
      onWarning: (m) => warnings.push(m),
    });
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test("auto with nothing available warns once and returns null", async () => {
    const warnings: string[] = [];
    const resolved = await resolveSandbox({
      sandboxName: "auto",
      detections: [],
      onWarning: (m) => warnings.push(m),
    });
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unsandboxed");
  });

  test("explicit provider that is unavailable throws with the reason", async () => {
    const broken = makeProvider("fake-broken", { available: false, reason: "binary missing" });
    registerSandboxProvider(broken);
    expect(
      resolveSandbox({ sandboxName: "fake-broken", detections: await detectionsOf(broken) }),
    ).rejects.toThrow("binary missing");
  });

  test("explicit provider that does not support the harness throws", async () => {
    const picky = makeProvider("fake-picky-explicit", {
      supportsHarness: (h) => h === "codex",
    });
    registerSandboxProvider(picky);
    expect(
      resolveSandbox({
        sandboxName: "fake-picky-explicit",
        harnessName: "opencode",
        detections: await detectionsOf(picky),
      }),
    ).rejects.toThrow("does not support");
  });

  test("explicit available provider resolves", async () => {
    const good = makeProvider("fake-good");
    registerSandboxProvider(good);
    const resolved = await resolveSandbox({
      sandboxName: "fake-good",
      detections: await detectionsOf(good),
    });
    expect(resolved?.provider.name).toBe("fake-good");
    expect(resolved?.detection.available).toBe(true);
  });

  test("AGENT_SANDBOX env var selects the provider", async () => {
    const envPicked = makeProvider("fake-env-picked");
    registerSandboxProvider(envPicked);
    process.env.AGENT_SANDBOX = "fake-env-picked";
    const resolved = await resolveSandbox({ detections: await detectionsOf(envPicked) });
    expect(resolved?.provider.name).toBe("fake-env-picked");
  });
});
