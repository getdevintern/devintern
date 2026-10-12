import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DetectedSandboxProvider } from "../src/sandbox/detect.js";
import { registerSandboxProvider } from "../src/sandbox/registry.js";
import { activeSandboxName, resolveSandbox } from "../src/sandbox/resolver.js";
import type {
  SandboxDetection,
  SandboxPolicy,
  SandboxProvider,
  WrappedCommand,
} from "../src/sandbox/types.js";

function makeProvider(
  name: string,
  overrides: Partial<Pick<SandboxProvider, "priority" | "supportsHarness" | "canNestInSandbox">> & {
    available?: boolean;
    reason?: string;
  } = {},
): SandboxProvider {
  return {
    name,
    displayName: name,
    priority: overrides.priority ?? 10,
    supportsHarness: overrides.supportsHarness,
    canNestInSandbox: overrides.canNestInSandbox,
    detect: async (): Promise<SandboxDetection> => ({
      available: overrides.available ?? true,
      reason: overrides.reason,
    }),
    wrapCommand: (
      path: string,
      args: readonly string[],
      _policy: SandboxPolicy,
    ): WrappedCommand => ({
      path: name,
      args: [path, ...args],
    }),
  };
}

function detectionsOf(...providers: SandboxProvider[]): Promise<DetectedSandboxProvider[]> {
  return Promise.all(
    providers.map(async (provider) => ({ provider, detection: await provider.detect() })),
  );
}

describe("resolveSandbox", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AGENT_SANDBOX;
    delete process.env.NONO_CAP_FILE;
    delete process.env.SANDBOX_RUNTIME;
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
      trustedEnv: {},
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
      trustedEnv: {},
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
      trustedEnv: {},
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
      trustedEnv: {},
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
      resolveSandbox({
        sandboxName: "fake-broken",
        trustedEnv: {},
        detections: await detectionsOf(broken),
      }),
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
        trustedEnv: {},
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
      trustedEnv: {},
      detections: await detectionsOf(good),
    });
    expect(resolved?.provider.name).toBe("fake-good");
    expect(resolved?.detection.available).toBe(true);
  });

  test("AGENT_SANDBOX env var selects the provider", async () => {
    const envPicked = makeProvider("fake-env-picked");
    registerSandboxProvider(envPicked);
    process.env.AGENT_SANDBOX = "fake-env-picked";
    const resolved = await resolveSandbox({
      trustedEnv: {},
      detections: await detectionsOf(envPicked),
    });
    expect(resolved?.provider.name).toBe("fake-env-picked");
  });

  test("activeSandboxName reports the enclosing nono sandbox", () => {
    expect(activeSandboxName({})).toBeUndefined();
    expect(activeSandboxName({ NONO_CAP_FILE: process.execPath })).toBe("nono");
  });

  test("activeSandboxName reports the enclosing srt sandbox marker", () => {
    expect(activeSandboxName({ SANDBOX_RUNTIME: "1" })).toBe("srt");
    expect(activeSandboxName({ SANDBOX_RUNTIME: "0" })).toBeUndefined();
  });

  test("activeSandboxName ignores a NONO_CAP_FILE pointing at a missing path", () => {
    expect(activeSandboxName({ NONO_CAP_FILE: "/nonexistent/cap.json" })).toBeUndefined();
  });

  test("activeSandboxName reports nono when both markers are present", () => {
    expect(activeSandboxName({ NONO_CAP_FILE: process.execPath, SANDBOX_RUNTIME: "1" })).toBe(
      "nono",
    );
  });

  test("auto does not add a nested sandbox when already inside one", async () => {
    const nested = makeProvider("nono", { priority: 50 });
    const other = makeProvider("fake-other", { priority: 5 });
    const warnings: string[] = [];
    const resolved = await resolveSandbox({
      sandboxName: "auto",
      trustedEnv: { NONO_CAP_FILE: process.execPath },
      detections: await detectionsOf(nested, other),
      onWarning: (m) => warnings.push(m),
    });
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Already running inside the nono sandbox");
  });

  test("explicit same provider is not nested when already inside a sandbox", async () => {
    const srt = makeProvider("srt");
    const warnings: string[] = [];
    const resolved = await resolveSandbox({
      sandboxName: "srt",
      trustedEnv: { SANDBOX_RUNTIME: "1" },
      detections: await detectionsOf(srt),
      onWarning: (m) => warnings.push(m),
    });
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not nesting another sandbox");
  });

  test("explicit different non-nestable provider is not stacked on an active sandbox", async () => {
    const other = makeProvider("fake-other");
    registerSandboxProvider(other);
    const warnings: string[] = [];
    const resolved = await resolveSandbox({
      sandboxName: "fake-other",
      trustedEnv: { NONO_CAP_FILE: process.execPath },
      detections: await detectionsOf(other),
      onWarning: (m) => warnings.push(m),
    });
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not adding a nested fake-other sandbox");
  });

  test("explicit nesting-capable provider still runs inside an active sandbox", async () => {
    const vm = makeProvider("fake-vm", { canNestInSandbox: true });
    registerSandboxProvider(vm);
    const warnings: string[] = [];
    const resolved = await resolveSandbox({
      sandboxName: "fake-vm",
      trustedEnv: { NONO_CAP_FILE: process.execPath },
      detections: await detectionsOf(vm),
      onWarning: (m) => warnings.push(m),
    });
    expect(resolved?.provider.name).toBe("fake-vm");
    expect(warnings).toHaveLength(0);
  });

  test("explicit provider is validated even when an active sandbox is present", async () => {
    const broken = makeProvider("fake-broken-active", {
      available: false,
      reason: "binary missing",
    });
    registerSandboxProvider(broken);
    expect(
      resolveSandbox({
        sandboxName: "fake-broken-active",
        trustedEnv: { NONO_CAP_FILE: process.execPath },
        detections: await detectionsOf(broken),
      }),
    ).rejects.toThrow("binary missing");
  });

  test("activeSandboxName ignores markers merged into process.env after module load", () => {
    const before = activeSandboxName();
    process.env.NONO_CAP_FILE = process.execPath;
    process.env.SANDBOX_RUNTIME = "1";
    expect(activeSandboxName()).toBe(before);
  });

  test("an active sandbox still rejects an unknown explicit provider", async () => {
    expect(
      resolveSandbox({
        sandboxName: "bogus",
        trustedEnv: { NONO_CAP_FILE: process.execPath },
        detections: [],
      }),
    ).rejects.toThrow("Unknown sandbox provider");
  });
});
