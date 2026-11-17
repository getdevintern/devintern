/**
 * Harness-aware sandbox selection: the single picker shared by
 *
 *   - the runtime resolver ({@link resolveSandbox}, used by every agent spawn
 *     and by failover when the next harness is spawned),
 *   - the worker startup chain preflight (`resolveHarnessChain`),
 *   - the doctors (`devintern sandbox` preflight and `devintern doctor`).
 *
 * All of them must answer "which sandbox wraps harness X for AGENT_SANDBOX=Y"
 * identically, otherwise preflight probes a harness through a provider the
 * real run never uses (e.g. `native` for `opencode`) and drops or keeps the
 * wrong chain entries. The decision considers, in order:
 *
 *   1. `none` → no sandbox.
 *   2. An enclosing sandbox with `auto` → inherit it (never nest).
 *   3. `auto` → highest-priority available provider that supports the harness;
 *      nothing compatible → run unsandboxed with a warning.
 *   4. Explicit name → removed/unknown/unavailable/harness-incompatible
 *      providers are errors (an explicit isolation request is never silently
 *      dropped); a non-nestable provider inside an enclosing sandbox inherits.
 *
 * {@link decideHarnessSandbox} is pure over its inputs (detections and the
 * enclosing sandbox are injected) so every caller can feed it the data it
 * already has; {@link resolveHarnessSandboxDecision} gathers those inputs.
 */

import { detectSandboxProviders } from "./detect.js";
import type { DetectedSandboxProvider } from "./detect.js";
import { sandboxInheritsEnclosingSandbox } from "./nesting.js";
import { getSandboxProvider, listSandboxProviders } from "./registry.js";
import type { SandboxDetection, SandboxProvider } from "./types.js";

/** Why an explicit sandbox request cannot be honored. */
export type SandboxDecisionErrorReason = "removed" | "unknown" | "unavailable" | "incompatible";

/** Outcome of picking the sandbox for one harness. */
export type HarnessSandboxDecision =
  | { kind: "none"; requested: string; harnessName?: string }
  | {
      /** `auto` found no available provider that supports the harness. */
      kind: "unsandboxed";
      requested: string;
      harnessName?: string;
      warning: string;
    }
  | {
      kind: "provider";
      requested: string;
      harnessName?: string;
      provider: SandboxProvider;
      detection: SandboxDetection;
    }
  | {
      /** The run inherits the sandbox already wrapping this process. */
      kind: "inherited";
      requested: string;
      harnessName?: string;
      activeSandbox: string;
      /** Explicit provider that was skipped (undefined for `auto`). */
      provider?: SandboxProvider;
    }
  | {
      kind: "error";
      requested: string;
      harnessName?: string;
      reason: SandboxDecisionErrorReason;
      message: string;
      provider?: SandboxProvider;
    };

/** Inputs for {@link decideHarnessSandbox}. */
export interface HarnessSandboxDecisionInput {
  /** Configured sandbox: `none`, `auto`, or an explicit provider name. */
  sandboxName: string;
  /** Harness that will be wrapped; omitted for harness-agnostic decisions. */
  harnessName?: string;
  /** Provider detections (from `detectSandboxProviders()`). */
  detections: readonly DetectedSandboxProvider[];
  /** Provider already wrapping this process, if any. */
  activeSandbox?: string;
}

/** Migration messages for retired providers (single source of truth). */
const REMOVED_SANDBOX_PROVIDERS = new Map<string, string>([
  [
    "srt",
    'Sandbox provider "srt" has been removed. Use "nono" for whole-process confinement ' +
      '(or "docker" for a microVM boundary). ' +
      "See https://devintern.com/docs/code/configuration#providers",
  ],
  [
    "smolvm",
    'Sandbox provider "smolvm" has been removed. Use "docker" for a microVM boundary ' +
      '(or "nono" for local confinement). ' +
      "See https://devintern.com/docs/code/configuration#providers",
  ],
]);

/**
 * Migration message for a retired sandbox provider.
 *
 * A `Map` lookup is deliberate: the key is untrusted input and an object
 * lookup would resolve prototype members such as `constructor`.
 *
 * @param name - Provider name from `--sandbox` or `AGENT_SANDBOX`.
 * @returns The migration message, or `undefined` when not a removed provider.
 */
export function removedSandboxProviderMessage(name: string): string | undefined {
  return REMOVED_SANDBOX_PROVIDERS.get(name);
}

/**
 * Actionable message for an explicit provider that cannot wrap a harness.
 *
 * @param sandboxName - Explicitly configured provider.
 * @param harnessName - Harness it cannot wrap.
 */
export function incompatibleSandboxMessage(sandboxName: string, harnessName: string): string {
  return (
    `Sandbox provider "${sandboxName}" does not support the "${harnessName}" harness. ` +
    `Use AGENT_SANDBOX=auto (picks a compatible provider per harness) or "nono" (it wraps any harness), ` +
    `or remove "${harnessName}" from AGENT_HARNESS.`
  );
}

/** Whether a provider can wrap the harness (no harness → any provider). */
function supports(provider: SandboxProvider, harnessName?: string): boolean {
  return !harnessName || !provider.supportsHarness || provider.supportsHarness(harnessName);
}

/**
 * Highest-priority available provider `auto` would pick for a harness.
 *
 * @param detections - Provider detections.
 * @param harnessName - Harness to filter compatibility by.
 * @returns The picked detection, or undefined when nothing is compatible.
 */
export function pickAutoSandboxProvider(
  detections: readonly DetectedSandboxProvider[],
  harnessName?: string,
): DetectedSandboxProvider | undefined {
  return detections
    .filter(
      ({ provider, detection }) =>
        detection.available && provider.priority > 0 && supports(provider, harnessName),
    )
    .sort((a, b) => b.provider.priority - a.provider.priority)[0];
}

/**
 * Decide which sandbox (if any) wraps a harness. Pure.
 *
 * @param input - Configured sandbox, harness, detections, enclosing sandbox.
 * @returns The decision every caller (runtime, preflight, doctor) shares.
 */
export function decideHarnessSandbox(input: HarnessSandboxDecisionInput): HarnessSandboxDecision {
  const requested = input.sandboxName.trim() || "none";
  const { harnessName, detections, activeSandbox } = input;
  if (requested === "none") return { kind: "none", requested, harnessName };

  // `auto` inherits the enclosing sandbox regardless of what it would pick.
  if (activeSandbox && sandboxInheritsEnclosingSandbox({ configured: requested, activeSandbox })) {
    return { kind: "inherited", requested, harnessName, activeSandbox };
  }

  if (requested === "auto") {
    const best = pickAutoSandboxProvider(detections, harnessName);
    if (!best) {
      return {
        kind: "unsandboxed",
        requested,
        harnessName,
        warning:
          "⚠️  AGENT_SANDBOX=auto: no sandbox provider available on this machine" +
          (harnessName ? ` for the "${harnessName}" harness` : "") +
          " — running the agent unsandboxed. Install nono (https://nono.sh) to enable isolation.",
      };
    }
    return {
      kind: "provider",
      requested,
      harnessName,
      provider: best.provider,
      detection: best.detection,
    };
  }

  const removed = removedSandboxProviderMessage(requested);
  if (removed)
    return { kind: "error", requested, harnessName, reason: "removed", message: removed };

  const provider =
    detections.find((d) => d.provider.name === requested)?.provider ??
    getSandboxProvider(requested);
  if (!provider) {
    const available = listSandboxProviders()
      .map((p) => `"${p.name}"`)
      .join(", ");
    return {
      kind: "error",
      requested,
      harnessName,
      reason: "unknown",
      message:
        `Unknown sandbox provider: "${requested}". ` +
        `Valid values: "none", "auto", ${available}. Set AGENT_SANDBOX or pass --sandbox.`,
    };
  }

  // Validate before the nesting decision: an unusable explicit request must
  // surface instead of silently inheriting the enclosing sandbox.
  const detection = detections.find((d) => d.provider.name === requested)?.detection ?? {
    available: false,
    reason: "not detected",
  };
  if (!detection.available) {
    return {
      kind: "error",
      requested,
      harnessName,
      reason: "unavailable",
      provider,
      message:
        `Sandbox provider "${requested}" is not usable on this machine: ` +
        `${detection.reason ?? "unavailable"}. Install it, or use AGENT_SANDBOX=auto or none.`,
    };
  }
  if (harnessName && !supports(provider, harnessName)) {
    return {
      kind: "error",
      requested,
      harnessName,
      reason: "incompatible",
      provider,
      message: incompatibleSandboxMessage(requested, harnessName),
    };
  }
  if (
    activeSandbox &&
    sandboxInheritsEnclosingSandbox({ configured: requested, activeSandbox, provider })
  ) {
    return { kind: "inherited", requested, harnessName, activeSandbox, provider };
  }
  return { kind: "provider", requested, harnessName, provider, detection };
}

/** Options for {@link resolveHarnessSandboxDecision}. */
export interface ResolveHarnessSandboxDecisionOptions {
  sandboxName: string;
  harnessName?: string;
  /** Reuse detections; otherwise detected (per-process cache) when needed. */
  detections?: readonly DetectedSandboxProvider[];
  /** Enclosing sandbox name (already validated, e.g. `activeSandboxName()`). */
  activeSandbox?: string;
}

/**
 * Ensure an explicitly requested provider has a detection result.
 *
 * The per-process detection cache can predate a provider's registration
 * (tests, plugins); the explicit request is then detected on its own instead
 * of being reported as unavailable.
 *
 * @param sandboxName - Configured sandbox name.
 * @param detections - Detections gathered so far.
 * @returns Detections including the explicit provider when it is registered.
 */
export async function withExplicitDetection(
  sandboxName: string,
  detections: readonly DetectedSandboxProvider[],
): Promise<readonly DetectedSandboxProvider[]> {
  const name = sandboxName.trim();
  if (!name || name === "none" || name === "auto") return detections;
  if (detections.some((d) => d.provider.name === name)) return detections;
  const provider = getSandboxProvider(name);
  if (!provider) return detections;
  let detection: SandboxDetection;
  try {
    detection = await provider.detect();
  } catch (error) {
    detection = { available: false, reason: `detection failed: ${(error as Error).message}` };
  }
  return [...detections, { provider, detection }];
}

/**
 * Gather inputs lazily and run {@link decideHarnessSandbox}.
 *
 * Detection is skipped when the decision cannot depend on it (`none`, or
 * `auto` inside an enclosing sandbox). An explicit provider missing from the
 * supplied detections is detected on its own.
 *
 * @param options - Configured sandbox, harness, optional detections.
 */
export async function resolveHarnessSandboxDecision(
  options: ResolveHarnessSandboxDecisionOptions,
): Promise<HarnessSandboxDecision> {
  const name = options.sandboxName.trim() || "none";
  const needsDetection = name !== "none" && !(name === "auto" && options.activeSandbox);
  const detections = needsDetection
    ? await withExplicitDetection(name, options.detections ?? (await detectSandboxProviders()))
    : (options.detections ?? []);
  return decideHarnessSandbox({
    sandboxName: name,
    harnessName: options.harnessName,
    detections,
    activeSandbox: options.activeSandbox,
  });
}

/**
 * Short operator-facing label for a decision (`nono`, `nono (inherited)`, …).
 *
 * @param decision - Decision to describe.
 */
export function describeSandboxDecision(decision: HarnessSandboxDecision): string {
  switch (decision.kind) {
    case "none":
      return "none (sandboxing off)";
    case "unsandboxed":
      return "none (auto: no compatible provider)";
    case "provider":
      return decision.provider.name;
    case "inherited":
      return `${decision.activeSandbox} (inherited)`;
    case "error":
      return decision.reason === "incompatible" && decision.harnessName
        ? `${decision.requested} (does not support ${decision.harnessName})`
        : `${decision.requested} (${decision.reason})`;
  }
}
