import { describe, expect, test } from "bun:test";

import { resolveProbeProvider } from "../src/sandbox/harness-probe.js";
import { sandboxInheritsEnclosingSandbox } from "../src/sandbox/nesting.js";
import { registerSandboxProvider } from "../src/sandbox/registry.js";
import { resolveSandbox } from "../src/sandbox/resolver.js";
import type { DetectedSandboxProvider } from "../src/sandbox/detect.js";
import type { SandboxProvider } from "../src/sandbox/types.js";

const activeEnv = { NONO_CAP_FILE: process.execPath };

function makeProvider(name: string, canNestInSandbox?: boolean): SandboxProvider {
  return {
    name,
    displayName: name,
    priority: canNestInSandbox ? 10 : 20,
    canNestInSandbox,
    detect: async () => ({ available: true }),
    wrapCommand: (path, args) => ({ path, args: [...args] }),
  };
}

async function detectionsOf(...providers: SandboxProvider[]): Promise<DetectedSandboxProvider[]> {
  return Promise.all(
    providers.map(async (provider) => ({ provider, detection: await provider.detect() })),
  );
}

describe("sandboxInheritsEnclosingSandbox", () => {
  const kernel = makeProvider("nesting-test-kernel");
  const vm = makeProvider("nesting-test-vm", true);

  test("no enclosing sandbox never inherits", () => {
    expect(sandboxInheritsEnclosingSandbox({ configured: "auto" })).toBe(false);
    expect(sandboxInheritsEnclosingSandbox({ configured: kernel.name, provider: kernel })).toBe(
      false,
    );
    expect(sandboxInheritsEnclosingSandbox({ configured: vm.name, provider: vm })).toBe(false);
  });

  test("auto inherits an enclosing sandbox regardless of provider", () => {
    expect(sandboxInheritsEnclosingSandbox({ configured: "auto", activeSandbox: "nono" })).toBe(
      true,
    );
    expect(
      sandboxInheritsEnclosingSandbox({
        configured: "auto",
        activeSandbox: "nono",
        provider: vm,
      }),
    ).toBe(true);
  });

  test("an explicit provider inherits only when it cannot nest", () => {
    expect(
      sandboxInheritsEnclosingSandbox({
        configured: kernel.name,
        activeSandbox: "nono",
        provider: kernel,
      }),
    ).toBe(true);
    expect(
      sandboxInheritsEnclosingSandbox({ configured: vm.name, activeSandbox: "nono", provider: vm }),
    ).toBe(false);
  });

  test("an unresolved explicit provider is not classified as inherited", () => {
    // Callers validate the explicit request before deciding; an unknown or
    // unavailable provider must error, not silently inherit.
    expect(
      sandboxInheritsEnclosingSandbox({ configured: kernel.name, activeSandbox: "nono" }),
    ).toBe(false);
  });
});

describe("nesting decision agrees across resolver and probe", () => {
  const kernel = makeProvider("nesting-sync-kernel");
  const vm = makeProvider("nesting-sync-vm", true);
  registerSandboxProvider(kernel);
  registerSandboxProvider(vm);

  const providerFor: Record<string, SandboxProvider> = {
    [kernel.name]: kernel,
    [vm.name]: vm,
  };

  for (const configured of ["auto", kernel.name, vm.name]) {
    for (const env of [{}, activeEnv]) {
      const label = `${configured} ${env === activeEnv ? "inside" : "outside"} a sandbox`;
      test(label, async () => {
        const detections = await detectionsOf(kernel, vm);
        const provider = configured === "auto" ? undefined : providerFor[configured];

        const inherited = sandboxInheritsEnclosingSandbox({
          configured,
          activeSandbox: env === activeEnv ? "nono" : undefined,
          provider,
        });

        // Runtime resolver: inherits (null) iff the predicate says so.
        const resolved = await resolveSandbox({
          sandboxName: configured,
          detections,
          trustedEnv: env,
        });
        expect(resolved === null).toBe(inherited);
        if (!inherited) {
          expect(resolved?.provider.name).toBe(configured === "auto" ? kernel.name : configured);
        }

        // Readiness probe: the wrapper-free inherited stand-in iff the
        // predicate says so, otherwise the real provider.
        const probe = await resolveProbeProvider(configured, { trustedEnv: env });
        expect(probe).toBeDefined();
        if (inherited) {
          expect(probe?.name).toBe("nono (inherited)");
        } else if (configured !== "auto") {
          expect(probe).toBe(providerFor[configured]!);
        }
      });
    }
  }
});
