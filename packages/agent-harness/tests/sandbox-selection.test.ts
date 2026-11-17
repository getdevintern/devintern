import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resetMiseShimWarnings, resolveHarnessChain } from "../src/harness-chain.js";
import type { DetectedSandboxProvider } from "../src/sandbox/detect.js";
import { resetHarnessSandboxProbeCache } from "../src/sandbox/harness-probe.js";
import { NativeSandboxProvider } from "../src/sandbox/providers/native.js";
import { NonoSandboxProvider } from "../src/sandbox/providers/nono.js";
import { resolveSandbox } from "../src/sandbox/resolver.js";
import { decideHarnessSandbox, describeSandboxDecision } from "../src/sandbox/selection.js";
import type { SandboxProvider } from "../src/sandbox/types.js";

const available = { available: true } as const;
/** The real native (priority 40) and nono (priority 30) providers, both "installed". */
const realDetections = (): DetectedSandboxProvider[] => [
  { provider: new NativeSandboxProvider(), detection: available },
  { provider: new NonoSandboxProvider(), detection: available },
];

/** Name of the provider a decision wraps with, or the decision kind. */
function picked(sandboxName: string, harnessName: string, detections = realDetections()): string {
  const decision = decideHarnessSandbox({ sandboxName, harnessName, detections });
  return decision.kind === "provider" ? decision.provider.name : decision.kind;
}

describe("decideHarnessSandbox", () => {
  test("auto filters by harness support: native only for claude-code/codex", () => {
    expect(picked("auto", "opencode")).toBe("nono");
    expect(picked("auto", "codex")).toBe("native");
    expect(picked("auto", "grok")).toBe("nono");
    expect(picked("auto", "claude-code")).toBe("native");
  });

  test("auto with nothing compatible runs unsandboxed with a warning naming the harness", () => {
    const decision = decideHarnessSandbox({
      sandboxName: "auto",
      harnessName: "grok",
      detections: [{ provider: new NativeSandboxProvider(), detection: available }],
    });
    expect(decision.kind).toBe("unsandboxed");
    if (decision.kind === "unsandboxed") expect(decision.warning).toContain('"grok"');
  });

  test("explicit incompatible provider is an actionable error naming sandbox, harness, and fixes", () => {
    const decision = decideHarnessSandbox({
      sandboxName: "native",
      harnessName: "opencode",
      detections: realDetections(),
    });
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") return;
    expect(decision.reason).toBe("incompatible");
    expect(decision.message).toContain('"native"');
    expect(decision.message).toContain('"opencode"');
    expect(decision.message).toContain("AGENT_SANDBOX=auto");
    expect(decision.message).toContain("AGENT_HARNESS");
  });

  test("explicit unavailable provider errors even inside an enclosing sandbox", () => {
    const decision = decideHarnessSandbox({
      sandboxName: "nono",
      harnessName: "codex",
      detections: [
        { provider: new NonoSandboxProvider(), detection: { available: false, reason: "missing" } },
      ],
      activeSandbox: "nono",
    });
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") expect(decision.reason).toBe("unavailable");
  });

  test("enclosing sandbox: auto inherits, explicit non-nestable inherits after validation", () => {
    expect(
      decideHarnessSandbox({
        sandboxName: "auto",
        harnessName: "grok",
        detections: [],
        activeSandbox: "nono",
      }).kind,
    ).toBe("inherited");
    const explicit = decideHarnessSandbox({
      sandboxName: "nono",
      harnessName: "grok",
      detections: realDetections(),
      activeSandbox: "nono",
    });
    expect(explicit.kind).toBe("inherited");
    expect(describeSandboxDecision(explicit)).toBe("nono (inherited)");
  });

  test("unknown and removed providers are errors", () => {
    expect(picked("nope", "codex")).toBe("error");
    const removed = decideHarnessSandbox({
      sandboxName: "srt",
      harnessName: "codex",
      detections: [],
    });
    expect(removed.kind === "error" && removed.reason).toBe("removed");
  });

  test("runtime resolveSandbox selects the same provider per harness", async () => {
    for (const harnessName of ["opencode", "codex", "grok"]) {
      const resolved = await resolveSandbox({
        sandboxName: "auto",
        harnessName,
        detections: realDetections(),
        trustedEnv: {},
        onWarning: () => {},
      });
      expect(resolved?.provider.name).toBe(picked("auto", harnessName));
    }
  });

  test("runtime resolveSandbox throws the shared actionable error for explicit incompatibility", async () => {
    await expect(
      resolveSandbox({
        sandboxName: "native",
        harnessName: "grok",
        detections: realDetections(),
        trustedEnv: {},
      }),
    ).rejects.toThrow('does not support the "grok" harness');
  });
});

describe("resolveHarnessChain with the shared picker", () => {
  const originalEnv = { ...process.env };
  const originalWarn = console.warn;
  let dir: string;
  let wrapped: Array<{ provider: string; harness?: string }>;

  /** Fake provider that records which harness it wrapped and runs `ok`/`fail`. */
  const fake = (
    name: string,
    priority: number,
    harnesses?: string[],
    fails: string[] = [],
  ): DetectedSandboxProvider => {
    const provider: SandboxProvider = {
      name,
      displayName: name,
      priority,
      detect: async () => available,
      ...(harnesses ? { supportsHarness: (h: string) => harnesses.includes(h) } : {}),
      wrapCommand: (_path, _args, policy) => {
        wrapped.push({ provider: name, harness: policy.harnessName });
        return fails.includes(policy.harnessName ?? "")
          ? { path: process.execPath, args: ["-e", "process.exit(3)"] }
          : { path: process.execPath, args: ["--version"] };
      },
    };
    return { provider, detection: available };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devintern-selection-"));
    wrapped = [];
    console.warn = () => {};
    resetMiseShimWarnings();
    resetHarnessSandboxProbeCache();
    for (const key of ["OPENCODE_CLI_PATH", "CODEX_CLI_PATH", "GROK_CLI_PATH", "AGENT_CLI_PATH"]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  });

  const installed = () => true;

  test("auto + opencode,codex,grok probes each harness through its runtime provider", async () => {
    // Unique names keep the probe cache per test; native-like supports codex only.
    const detections = [
      fake("native-like-a", 40, ["claude-code", "codex"]),
      fake("nono-like-a", 30),
    ];
    const chain = await resolveHarnessChain({
      raw: "opencode,codex,grok",
      isInstalled: installed,
      sandboxName: "auto",
      detections,
      activeSandbox: undefined,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["opencode", "codex", "grok"]);
    expect(chain.issues).toEqual([]);
    expect(wrapped.sort((a, b) => (a.harness ?? "").localeCompare(b.harness ?? ""))).toEqual([
      { provider: "native-like-a", harness: "codex" },
      { provider: "nono-like-a", harness: "grok" },
      { provider: "nono-like-a", harness: "opencode" },
    ]);
    expect(chain.evaluations?.map((e) => [e.name, e.sandboxLabel, e.status])).toEqual([
      ["opencode", "nono-like-a", "ready"],
      ["codex", "native-like-a", "ready"],
      ["grok", "nono-like-a", "ready"],
    ]);
  });

  test("a primary that cannot start is dropped when a compatible fallback remains", async () => {
    const detections = [
      fake("only-codex-b", 40, ["codex"]),
      fake("fails-opencode-b", 30, undefined, ["opencode"]),
    ];
    const chain = await resolveHarnessChain({
      raw: "opencode,codex",
      isInstalled: installed,
      sandboxName: "auto",
      detections,
      activeSandbox: undefined,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex"]);
    expect(chain.issues).toHaveLength(1);
    expect(chain.issues[0]!.requested).toBe("opencode");
    expect(chain.issues[0]!.message).toContain("Skipping it");
    const primary = chain.evaluations?.[0];
    expect(primary?.retained).toBe(false);
    expect(primary?.status).toBe("not-ready");
  });

  test("keeps the primary only when no entry can start", async () => {
    const detections = [fake("fails-all-c", 30, undefined, ["opencode", "grok"])];
    const chain = await resolveHarnessChain({
      raw: "opencode,grok",
      isInstalled: installed,
      sandboxName: "auto",
      detections,
      activeSandbox: undefined,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["opencode"]);
    expect(chain.issues.map((i) => i.requested)).toEqual(["opencode", "grok"]);
    expect(chain.issues[0]!.message).toContain("no other harness in the chain can start");
  });

  test("explicit incompatible provider drops only the entries it cannot wrap", async () => {
    const detections = [fake("explicit-d", 40, ["codex"])];
    const chain = await resolveHarnessChain({
      raw: "opencode,codex,grok",
      isInstalled: installed,
      sandboxName: "explicit-d",
      detections,
      activeSandbox: undefined,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["codex"]);
    expect(chain.issues.map((i) => i.requested)).toEqual(["opencode", "grok"]);
    expect(chain.issues[0]!.message).toContain('does not support the "opencode" harness');
  });

  test("an unavailable explicit provider leaves the chain intact and reports every entry", async () => {
    const detections: DetectedSandboxProvider[] = [
      { ...fake("down-e", 30), detection: { available: false, reason: "not installed" } },
    ];
    const chain = await resolveHarnessChain({
      raw: "opencode,codex",
      isInstalled: installed,
      sandboxName: "down-e",
      detections,
      activeSandbox: undefined,
    });
    expect(chain.entries.map((e) => e.name)).toEqual(["opencode", "codex"]);
    expect(chain.evaluations?.every((e) => e.status === "not-ready")).toBe(true);
    expect(chain.evaluations?.[0]?.reason).toContain('"down-e" is not usable');
  });

  test("flags a mise shim under a sandbox with the CLI path fix", async () => {
    const shim = join(dir, "codex");
    writeFileSync(shim, '#!/bin/sh\nexec mise x codex@latest -- codex "$@"\n');
    chmodSync(shim, 0o755);
    process.env.CODEX_CLI_PATH = shim;
    const chain = await resolveHarnessChain({
      raw: "codex",
      isInstalled: installed,
      sandboxName: "auto",
      detections: [fake("shim-f", 30)],
      activeSandbox: undefined,
    });
    const evaluation = chain.evaluations?.[0];
    expect(evaluation?.miseShim?.path).toBe(shim);
    expect(evaluation?.status).toBe("warning");
    expect(evaluation?.hint).toContain("CODEX_CLI_PATH=");
  });

  test("records nono's generic-profile fallback for a harness without a pack", async () => {
    // grok has no published nono pack, so this needs no `nono` binary.
    const chain = await resolveHarnessChain({
      raw: "grok",
      isInstalled: installed,
      sandboxName: "auto",
      detections: [fake("nono", 30)],
      activeSandbox: undefined,
    });
    const evaluation = chain.evaluations?.[0];
    expect(evaluation?.sandboxLabel).toBe("nono");
    expect(evaluation?.status).toBe("ready");
    expect(evaluation?.packNote).toContain('no pack profile for "grok"');
  });
});
