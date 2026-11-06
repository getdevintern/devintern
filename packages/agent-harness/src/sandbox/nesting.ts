/**
 * Single source of truth for "does this run inherit the enclosing sandbox?".
 *
 * Three consumers need the same answer:
 *   - the runtime resolver ({@link resolveSandbox}),
 *   - the startup readiness probe (`resolveProbeProvider`),
 *   - the `devintern sandbox` doctor (`collectHarnessPreflight` and its
 *     "Next run" line).
 *
 * They must agree exactly: a probe that wraps a provider the real run will not
 * use can drop a valid fallback as `sandbox-incompatible`, and a doctor line
 * that disagrees with the resolver reports a next run that will not happen.
 * Keeping the decision here means a new provider tier or skip condition is a
 * one-line change instead of three copies to keep in sync.
 *
 * Pure and provider-agnostic (no detection, probing, or env reading) so every
 * caller can share it.
 */

import type { SandboxProvider } from "./types.js";

/** Inputs for {@link sandboxInheritsEnclosingSandbox}. */
export interface SandboxNestingDecision {
  /** Configured sandbox name: "auto", an explicit provider, or "none". */
  configured: string;
  /** Provider already wrapping this process, or undefined when unsandboxed. */
  activeSandbox?: string;
  /**
   * Provider the run would wrap with, once resolved. Omitted before detection:
   * `auto` inherits regardless of which provider it would have picked, while
   * an explicit request cannot be classified until its provider is validated.
   */
  provider?: Pick<SandboxProvider, "canNestInSandbox">;
}

/**
 * Whether the run must inherit the sandbox already wrapping this process
 * instead of nesting another provider.
 *
 * `auto` never adds a second sandbox, whatever provider it would otherwise
 * pick. An explicit provider is skipped unless it declares
 * {@link SandboxProvider.canNestInSandbox}: microVMs run in their own guest
 * and may nest, while kernel-namespace wrappers (`nono`) and the native
 * sandbox cannot (the inner instance cannot set up its state under the outer
 * confinement and exits before the agent starts).
 *
 * @param decision - Configured name, enclosing sandbox, and resolved provider.
 * @returns True when the enclosing confinement is the run's boundary.
 */
export function sandboxInheritsEnclosingSandbox({
  configured,
  activeSandbox,
  provider,
}: SandboxNestingDecision): boolean {
  if (!activeSandbox) return false;
  if (configured === "auto") return true;
  // No provider resolved yet: an explicit request has not been validated, so
  // it must not be treated as inherited (callers validate first).
  if (!provider) return false;
  return !provider.canNestInSandbox;
}
