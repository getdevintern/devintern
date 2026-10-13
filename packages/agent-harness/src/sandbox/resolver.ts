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

import { existsSync } from "fs";
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
  /**
   * Environment to inspect for enclosing-sandbox markers. Defaults to the real
   * process environment captured when this module loaded — before the host
   * merges `.devintern-code/.env` — so repository-controlled values cannot
   * masquerade as an active sandbox. Override in tests and advanced hosts.
   */
  trustedEnv?: NodeJS.ProcessEnv;
}

/**
 * Real process environment captured when this module first loads. The host
 * merges the repository-controlled `.devintern-code/.env` into `process.env`
 * afterwards, so that file must never be able to inject an enclosing-sandbox
 * marker: doing so would let an untrusted repo disable an explicitly requested
 * (`--sandbox`/`AGENT_SANDBOX`) sandbox and run the agent unsandboxed. Only
 * markers present here — before that merge — are trusted.
 */
const STARTUP_ENV: NodeJS.ProcessEnv = { ...process.env };

interface ActiveSandboxMarker {
  /** Provider that installs this marker. */
  provider: string;
  /**
   * Optional sanity check on the marker's value. Applied to the trusted
   * startup snapshot, so it guards against a stale/incoherent value rather
   * than against repository-controlled injection (which the snapshot already
   * excludes).
   */
  validate?: (value: string) => boolean;
}

/**
 * Environment markers that reveal an enclosing sandbox wrapper, mapped to the
 * provider that installed them and an optional value check.
 *
 * - nono exports `NONO_CAP_FILE` (a path to its capability set) into every
 *   sandboxed process; the path is validated to exist so a stale value does
 *   not disable an explicitly requested sandbox.
 * - srt (sandbox-runtime) exports `SANDBOX_RUNTIME=1`.
 *
 * Precedence: when both markers are present (only possible in the trusted
 * startup snapshot), insertion order decides — `nono` is reported before
 * `srt`. There is no reliable signal to disambiguate a genuinely nested pair,
 * so this order is deliberate and documented.
 */
const ACTIVE_SANDBOX_ENV: Record<string, ActiveSandboxMarker> = {
  NONO_CAP_FILE: { provider: "nono", validate: (value) => existsSync(value) },
  SANDBOX_RUNTIME: { provider: "srt", validate: (value) => value === "1" },
};

/**
 * Name of the sandbox provider already wrapping this process, if any.
 *
 * Re-wrapping with any kernel sandbox — the same provider or a different one —
 * would nest the sandbox, which nono/srt cannot do (the inner instance cannot
 * create its session state under the outer confinement and exits non-zero
 * before the agent starts). Callers use this to avoid the redundant layer.
 *
 * @param env - Environment to inspect. Defaults to the trusted startup snapshot
 *   ({@link STARTUP_ENV}), not live `process.env`, so a repository's
 *   `.devintern-code/.env` cannot forge a marker.
 * @returns The provider name, or `undefined` when unsandboxed.
 */
export function activeSandboxName(env: NodeJS.ProcessEnv = STARTUP_ENV): string | undefined {
  for (const [marker, { provider, validate }] of Object.entries(ACTIVE_SANDBOX_ENV)) {
    const value = env[marker];
    if (value && (!validate || validate(value))) return provider;
  }
  return undefined;
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
  const active = activeSandboxName(options?.trustedEnv);

  if (name === "none") {
    return null;
  }

  // Already inside a kernel sandbox. Nesting a namespace-based wrapper — the
  // same provider or a different one — is unsupported on Linux/macOS: the inner
  // instance cannot set up its namespaces/state under the outer confinement and
  // exits non-zero before the agent starts. The existing confinement is the
  // boundary, so `auto` and explicitly requested non-nestable providers inherit
  // rather than stack a second sandbox. MicroVM providers may nest (see below).
  const skipNesting = (activeName: string, requestedName?: string): null => {
    warn(
      requestedName && requestedName !== activeName
        ? `ℹ️  Already running inside the ${activeName} sandbox — not adding a nested ` +
            `${requestedName} sandbox; the agent inherits the existing confinement.`
        : `ℹ️  Already running inside the ${activeName} sandbox — not nesting another sandbox; ` +
            "the agent inherits the existing confinement.",
    );
    return null;
  };

  if (name === "auto") {
    if (active) return skipNesting(active);
    const detections = options?.detections ?? (await detectSandboxProviders());
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

  // Validate the explicit request before deciding whether to nest: an
  // unavailable or harness-incompatible provider must surface its conflict
  // instead of silently inheriting the enclosing sandbox.
  const detections = options?.detections ?? (await detectSandboxProviders());
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

  // Already inside a sandbox. Only providers that cannot nest (kernel wrappers
  // and the native harness sandbox) are skipped; microVM providers run in their
  // own guest and may run inside the enclosing confinement.
  if (active && !provider.canNestInSandbox) {
    return skipNesting(active, name);
  }

  return { provider, detection, harnessName };
}
