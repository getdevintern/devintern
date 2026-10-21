/**
 * Priority-ordered harness chain (`AGENT_HARNESS=claude-code,codex`).
 *
 * A comma-separated `AGENT_HARNESS` value names a failover chain: the first
 * entry is the preferred harness, later entries are fallbacks used when an
 * earlier one hits its usage/rate limit. Parsing and resolution live here so
 * every consumer (worker failover, readiness probe, one-shot runs) sees the
 * same list semantics:
 *
 *   - Entries are split on commas and trimmed; empty entries are dropped.
 *   - Aliases (e.g. `agy`, deprecated `gemini`) resolve to canonical names.
 *   - Duplicate canonical names collapse to the first occurrence, preserving
 *     the requested priority.
 *   - An empty/unset value defaults to `["claude-code"]`.
 *
 * Resolution validates each name against the registry, resolves its CLI path
 * per harness (so `AGENT_CLI_PATH` cannot leak across harnesses — harness
 * specific `<HARNESS>_CLI_PATH` overrides and defaults apply instead), and
 * checks installability. Unknown or not-installed entries are reported as
 * issues for the caller to warn about and skipped rather than fatal, unless
 * that would leave an empty chain (then the full list is kept and the spawn
 * itself surfaces the real error, matching single-harness behavior).
 *
 * When a sandbox is configured, usable entries are also executed through the
 * sandbox wrapper (`<path> --version`) before they are trusted. A fallback
 * that cannot start under the sandbox is dropped with an actionable issue; a
 * failing primary is kept and reported because an empty chain is worse.
 */

import { DEFAULT_HARNESS_NAME, getHarness, HARNESS_ALIASES, listHarnesses } from "./registry.js";
import { getHarnessCliCommand, isHarnessCliAvailable } from "./resolver.js";
import { probeHarnessUnderSandbox, resolveProbeProvider } from "./sandbox/harness-probe.js";
import type { HarnessSandboxProbeResult } from "./sandbox/harness-probe.js";
import { detectMiseShim, harnessCliPathEnvKey, miseShimFixHint } from "./sandbox/shim-detect.js";
import type { SandboxProvider } from "./sandbox/types.js";
import type { AgentHarness } from "./types.js";

/**
 * Parse a raw (possibly comma-separated) harness list into canonical names.
 *
 * Applies registry aliases, drops empty entries, and de-duplicates canonical
 * names keeping the first occurrence. Returns `[DEFAULT_HARNESS_NAME]` when
 * nothing usable remains.
 *
 * @param raw - Raw `AGENT_HARNESS` value (already env-resolved), may be undefined.
 * @returns Ordered canonical harness names (priority first).
 */
export function parseHarnessList(raw: string | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const requested = part.trim();
    if (!requested) {
      continue;
    }
    const canonical = getHarness(requested)?.name ?? requested;
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    names.push(canonical);
  }
  return names.length > 0 ? names : [DEFAULT_HARNESS_NAME];
}

/** One ordered, resolved entry of the harness chain. */
export interface HarnessChainEntry {
  /** Canonical registry name (after alias resolution). */
  readonly name: string;
  readonly harness: AgentHarness;
  /** Resolved CLI command/path for this harness. */
  readonly path: string;
  /** Whether the resolved CLI is installed/reachable on this machine. */
  readonly installed: boolean;
}

/** A chain entry that could not be used, with a warning message. */
export interface HarnessChainIssue {
  /** Name as written in the list (after alias resolution). */
  readonly requested: string;
  readonly reason: "unknown" | "not-installed" | "sandbox-incompatible";
  readonly message: string;
}

/** Result of resolving a harness chain. */
export interface ResolvedHarnessChain {
  /** Ordered usable entries (priority first). */
  readonly entries: HarnessChainEntry[];
  /** Entries dropped from (or, for a failing primary, kept with a warning in) the chain. */
  readonly issues: HarnessChainIssue[];
  /** All canonical names as parsed from the raw value (before dropping). */
  readonly parsed: string[];
  /** True when the raw value listed more than one harness. */
  readonly multiHarness: boolean;
}

/** Options for {@link resolveHarnessChain}. */
export interface HarnessChainOptions {
  /** Raw list value; defaults to `AGENT_HARNESS` env (or the default harness). */
  raw?: string;
  /**
   * Probe installability and drop not-installed entries (default true).
   * When false, every known entry is kept with `installed` reported as-is.
   */
  checkInstalled?: boolean;
  /**
   * When false, suppress deprecation warnings for aliased harness names
   * (e.g. `gemini` → `antigravity`). Defaults to true.
   */
  warnDeprecated?: boolean;
  /** Installability predicate override (tests). Defaults to PATH probing. */
  isInstalled?: (entry: { name: string; path: string }) => boolean;
  /**
   * Effective sandbox name for readiness probing. Defaults to `AGENT_SANDBOX`.
   * `none`/empty disables probing entirely.
   */
  sandboxName?: string;
  /** Provider override (tests/doctor); otherwise derived from `sandboxName`. */
  sandboxProvider?: SandboxProvider;
  /**
   * Sandbox readiness probe override (tests). Called only when a sandbox is
   * configured. Returning `{ ok: false, reason }` marks the entry as
   * sandbox-incompatible; thrown errors fail open.
   */
  probeSandbox?: (entry: {
    name: string;
    path: string;
  }) => HarnessSandboxProbeResult | Promise<HarnessSandboxProbeResult>;
}

/**
 * Resolve the CLI path for one parsed chain entry.
 *
 * Harness-specific `<HARNESS>_CLI_PATH` overrides and the harness default
 * apply; the global `AGENT_CLI_PATH` only applies to the first (priority)
 * entry so a single-value configuration keeps resolving exactly like
 * {@link resolveHarness} does today, while a stale global override cannot
 * stick to a fallback harness selected during failover.
 *
 * @param harness - Registered harness for the entry.
 * @param isPrimary - Whether this is the first (priority) chain entry.
 * @param warnDeprecated - Whether legacy path env vars may warn.
 * @returns The CLI command or path to spawn/probe for this entry.
 */
function resolveEntryPath(
  harness: AgentHarness,
  isPrimary: boolean,
  warnDeprecated?: boolean,
): string {
  if (isPrimary && process.env.AGENT_CLI_PATH) {
    return process.env.AGENT_CLI_PATH;
  }
  return getHarnessCliCommand(harness, { warnDeprecated });
}

const warnedMiseShims = new Set<string>();

/**
 * Warn once per process about a harness path that is a mise wrapper script.
 *
 * @param entry - Resolved chain entry to inspect.
 */
function warnIfMiseShim(entry: HarnessChainEntry): void {
  const shim = detectMiseShim(entry.path);
  if (!shim.shim || warnedMiseShims.has(shim.path)) {
    return;
  }
  warnedMiseShims.add(shim.path);
  console.warn(
    `⚠️  Harness "${entry.name}" resolves to a mise shim (${shim.path}) that runs ` +
      `"${shim.match ?? "mise use/mise x"}". Under a sandbox the install step is denied. ` +
      `Point it at the real executable: ${miseShimFixHint(entry.name)}.`,
  );
}

/** Reset the once-per-process mise shim warning cache (tests). */
export function resetMiseShimWarnings(): void {
  warnedMiseShims.clear();
}

/**
 * Resolve the chain without executing sandbox probes.
 *
 * Used by lazy fallbacks and tests that must stay synchronous. Prefer
 * {@link resolveHarnessChain} at startup so sandbox-incompatible entries are
 * filtered before the first task runs.
 *
 * @param options - Raw value override and installability toggles.
 * @returns The resolved chain without sandbox readiness filtering.
 */
export function resolveHarnessChainSync(options: HarnessChainOptions = {}): ResolvedHarnessChain {
  const raw = options.raw ?? process.env.AGENT_HARNESS;
  const parsed = parseHarnessList(raw);
  const checkInstalled = options.checkInstalled ?? true;
  const warnDeprecated = options.warnDeprecated;

  const entries: HarnessChainEntry[] = [];
  const issues: HarnessChainIssue[] = [];

  const buildEntry = (
    canonical: string,
    isPrimary: boolean,
    reportIssues: boolean,
    enforceInstalled: boolean,
  ): HarnessChainEntry | null => {
    const harness = getHarness(canonical);
    if (!harness) {
      if (reportIssues) {
        const availableNames = listHarnesses()
          .map((h) => `"${h.name}"`)
          .join(", ");
        issues.push({
          requested: canonical,
          reason: "unknown",
          message: `Unknown agent harness "${canonical}" in AGENT_HARNESS; skipping it. Available harnesses: ${availableNames}.`,
        });
      }
      return null;
    }

    const path = resolveEntryPath(harness, isPrimary, warnDeprecated);
    const installed = options.isInstalled
      ? options.isInstalled({ name: harness.name, path })
      : isHarnessCliAvailable(path);

    if (enforceInstalled && checkInstalled && !installed) {
      if (reportIssues) {
        const envKey = harness.name.toUpperCase().replace(/-/g, "_");
        issues.push({
          requested: canonical,
          reason: "not-installed",
          message: `Harness "${canonical}" is not installed (looked for "${path}"); skipping it. Install its CLI or set ${envKey}_CLI_PATH to the executable.`,
        });
      }
      return null;
    }

    return { name: harness.name, harness, path, installed };
  };

  // Emit deprecation warnings for requested alias names (e.g. `gemini`),
  // once per distinct alias, mirroring resolveHarness's behavior.
  if (warnDeprecated !== false) {
    const warnedAliases = new Set<string>();
    for (const token of (raw ?? "").split(",")) {
      const requested = token.trim();
      const alias = requested ? HARNESS_ALIASES[requested] : undefined;
      if (alias?.deprecated && alias.warning && !warnedAliases.has(requested)) {
        warnedAliases.add(requested);
        console.warn(`⚠️  ${alias.warning}`);
      }
    }
  }

  parsed.forEach((canonical, index) => {
    const entry = buildEntry(canonical, index === 0, true, true);
    if (entry) {
      entries.push(entry);
    }
  });

  if (entries.length === 0) {
    if (parsed.every((canonical) => !getHarness(canonical))) {
      // Nothing but unknown names: a configuration error, same as handing
      // resolveHarness a single invalid name.
      const availableNames = listHarnesses()
        .map((h) => `"${h.name}"`)
        .join(", ");
      throw new Error(
        `Unknown agent harness "${parsed.join(",")}" in AGENT_HARNESS. ` +
          `Available harnesses: ${availableNames}. ` +
          `Set AGENT_HARNESS to a comma-separated list of registered harnesses.`,
      );
    }
    // Everything was dropped as not installed: keep the full parsed list so
    // the spawn path reports the familiar "CLI not found" error instead of
    // failing startup with an empty chain.
    parsed.forEach((canonical, index) => {
      const entry = buildEntry(canonical, index === 0, false, false);
      if (entry) {
        entries.push(entry);
      }
    });
  }

  return {
    entries,
    issues,
    parsed,
    multiHarness: parsed.length > 1,
  };
}

/** Build the actionable issue for a harness that failed its sandbox probe. */
function sandboxIncompatibleIssue(
  entry: HarnessChainEntry,
  providerName: string,
  reason: string,
  isPrimary: boolean,
): HarnessChainIssue {
  const fix = `${harnessCliPathEnvKey(entry.name)}=/path/to/${entry.name}`;
  const kept = isPrimary ? " Keeping it as the primary entry so the chain is not empty." : "";
  return {
    requested: entry.name,
    reason: "sandbox-incompatible",
    message:
      `Harness "${entry.name}" (${entry.path}) cannot start under the ${providerName} sandbox: ` +
      `${reason}. Pin the real binary with ${fix}.${kept}`,
  };
}

/**
 * Resolve the priority-ordered harness chain from a comma-separated value.
 *
 * Unknown names and (when `checkInstalled`) not-installed CLIs are reported in
 * `issues` and skipped; if nothing survives, the full parsed list is kept so
 * spawning fails with the familiar actionable error instead of an empty chain.
 *
 * When a sandbox is configured, entries are probed in parallel through the
 * sandbox wrapper. Fallbacks that cannot start are dropped; a failing primary
 * is kept with an issue because an empty chain is worse. Probe infrastructure
 * errors fail open (the entry is kept).
 *
 * @param options - Raw value override, installability toggles, and test hooks.
 * @returns The resolved chain with usable entries and dropped-entry issues.
 */
export async function resolveHarnessChain(
  options: HarnessChainOptions = {},
): Promise<ResolvedHarnessChain> {
  const base = resolveHarnessChainSync(options);
  const sandboxName = (options.sandboxName ?? process.env.AGENT_SANDBOX ?? "none").trim();
  if (!sandboxName || sandboxName === "none" || base.entries.length === 0) {
    return base;
  }

  // Shim warnings only matter when confinement is active: unsandboxed users
  // can run a mise wrapper just fine.
  for (const entry of base.entries) {
    warnIfMiseShim(entry);
  }

  let provider = options.sandboxProvider;
  if (!provider && !options.probeSandbox) {
    try {
      provider = await resolveProbeProvider(sandboxName);
    } catch {
      provider = undefined;
    }
  }
  if (!provider && !options.probeSandbox) {
    // No usable provider to probe through; startup will surface the sandbox
    // error. Never fail the chain because readiness probing itself failed.
    return base;
  }

  const providerLabel = provider?.name ?? sandboxName;
  const probe =
    options.probeSandbox ??
    ((entry: { name: string; path: string }) =>
      probeHarnessUnderSandbox({
        path: entry.path,
        provider: provider as SandboxProvider,
        harnessName: entry.name,
      }));

  const results = await Promise.all(
    base.entries.map(async (entry): Promise<HarnessSandboxProbeResult> => {
      if (!entry.installed) {
        return { ok: true };
      }
      try {
        return await probe({ name: entry.name, path: entry.path });
      } catch {
        // Probe infrastructure failure (e.g. provider wrap throws) is not
        // evidence that the harness is unusable — fail open.
        return { ok: true };
      }
    }),
  );

  const entries: HarnessChainEntry[] = [];
  const issues = [...base.issues];
  base.entries.forEach((entry, index) => {
    const result = results[index] ?? { ok: true };
    if (result.ok) {
      entries.push(entry);
      return;
    }
    const isPrimary = index === 0;
    issues.push(sandboxIncompatibleIssue(entry, providerLabel, result.reason, isPrimary));
    if (isPrimary) {
      entries.push(entry);
    }
  });

  return { ...base, entries, issues };
}
