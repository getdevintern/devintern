/**
 * Resolve which sandbox provider to use, mirroring `../resolver.ts`.
 *
 * Resolution order for the provider name:
 *   1. `options.sandboxName` (e.g. from a `--sandbox` CLI flag)
 *   2. `AGENT_SANDBOX` environment variable
 *   3. Default to "none" (backward compatible: agents run unsandboxed)
 *
 * Semantics:
 *   - "none"  → null; the caller spawns the agent directly, exactly as today.
 *   - "auto"  → highest-priority available provider that supports the harness;
 *               when nothing is available the run proceeds unsandboxed with a
 *               single warning (auto is an upgrade, not a guarantee).
 *   - explicit name → the provider must be available and support the harness,
 *               otherwise this throws with an actionable message. A user who
 *               explicitly asked for isolation must never silently run without it.
 */

import { detectSandboxProviders } from "./detect.js";
import type { DetectedSandboxProvider } from "./detect.js";
import { getSandboxProvider, listSandboxProviders } from "./registry.js";
import type { ResolvedSandbox } from "./types.js";

export interface SandboxResolutionOptions {
  /** Explicit provider name (e.g. "nono"), or "none"/"auto". */
  sandboxName?: string;
  /** Harness the sandbox will wrap; used to filter incompatible providers. */
  harnessName?: string;
  /** Warning sink for the auto-mode "nothing available" message. */
  onWarning?: (message: string) => void;
  /**
   * Reuse prior detection results (e.g. from a doctor command) instead of
   * running detection again.
   */
  detections?: DetectedSandboxProvider[];
}

/**
 * Resolve the sandbox provider for a run.
 *
 * @param options - Optional overrides for provider name and harness filtering.
 * @returns The resolved provider with its detection result, or `null` to run unsandboxed.
 * @throws {Error} When an unknown or explicitly requested but unusable provider is named.
 */
export async function resolveSandbox(
  options?: SandboxResolutionOptions,
): Promise<ResolvedSandbox | null> {
  const name = options?.sandboxName || process.env.AGENT_SANDBOX || "none";
  const harnessName = options?.harnessName;
  const warn = options?.onWarning ?? ((message: string) => console.warn(message));

  if (name === "none") {
    return null;
  }

  const detections = options?.detections ?? (await detectSandboxProviders());

  if (name === "auto") {
    const candidates = detections
      .filter(({ provider, detection }) => {
        if (!detection.available || provider.priority <= 0) return false;
        if (harnessName && provider.supportsHarness && !provider.supportsHarness(harnessName)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.provider.priority - a.provider.priority);

    const best = candidates[0] ? { ...candidates[0], harnessName } : undefined;
    if (!best) {
      warn(
        "⚠️  AGENT_SANDBOX=auto: no sandbox provider available on this machine — " +
          "running the agent unsandboxed. Install nono (https://nono.sh) or srt " +
          "(npm install -g @anthropic-ai/sandbox-runtime) to enable isolation.",
      );
      return null;
    }
    return best;
  }

  const provider = getSandboxProvider(name);
  if (!provider) {
    const available = listSandboxProviders()
      .map((p) => `"${p.name}"`)
      .join(", ");
    throw new Error(
      `Unknown sandbox provider: "${name}". ` +
        `Valid values: "none", "auto", ${available}. Set AGENT_SANDBOX or pass --sandbox.`,
    );
  }

  const detected = detections.find((d) => d.provider.name === name);
  const detection = detected?.detection ?? (await provider.detect());
  if (!detection.available) {
    throw new Error(
      `Sandbox provider "${name}" is not usable on this machine: ${detection.reason ?? "unavailable"}`,
    );
  }

  if (harnessName && provider.supportsHarness && !provider.supportsHarness(harnessName)) {
    throw new Error(
      `Sandbox provider "${name}" does not support the "${harnessName}" harness. ` +
        'Use "nono" or "srt" (they wrap any harness), or switch AGENT_HARNESS.',
    );
  }

  return { provider, detection, harnessName };
}
