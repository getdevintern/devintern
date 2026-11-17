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
import { getHarnessCliCommand, isHarnessCliAvailable, resolveExecutablePath } from "./resolver.js";
import { detectSandboxProviders } from "./sandbox/detect.js";
import type { DetectedSandboxProvider } from "./sandbox/detect.js";
import { probeHarnessForDecision } from "./sandbox/harness-probe.js";
import type { HarnessSandboxProbeResult } from "./sandbox/harness-probe.js";
import { describeNonoPack } from "./sandbox/providers/nono.js";
import { activeSandboxName } from "./sandbox/resolver.js";
import {
  decideHarnessSandbox,
  describeSandboxDecision,
  incompatibleSandboxMessage,
  withExplicitDetection,
} from "./sandbox/selection.js";
import type { HarnessSandboxDecision } from "./sandbox/selection.js";
import { detectMiseShim, harnessCliPathEnvKey, miseShimFixHint } from "./sandbox/shim-detect.js";
import type { MiseShimInfo } from "./sandbox/shim-detect.js";
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
  /**
   * Sandbox-aware evaluation of every resolved entry (including dropped
   * ones), in chain order. Only set by the async {@link resolveHarnessChain}.
   */
  readonly evaluations?: HarnessChainEvaluation[];
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
   * Environment to inspect for enclosing-sandbox markers when deriving the
   * probe provider. Defaults to the trusted startup snapshot captured by
   * `activeSandboxName()`, so tests can inject markers without mutating the
   * real process environment.
   */
  trustedEnv?: NodeJS.ProcessEnv;
  /**
   * Sandbox readiness probe override (tests). Called only when a sandbox is
   * configured. Returning `{ ok: false, reason }` marks the entry as
   * sandbox-incompatible; thrown errors fail open.
   */
  probeSandbox?: (entry: {
    name: string;
    path: string;
  }) => HarnessSandboxProbeResult | Promise<HarnessSandboxProbeResult>;
  /** Provider detections to reuse (doctor); otherwise detected on demand. */
  detections?: readonly DetectedSandboxProvider[];
  /**
   * Enclosing sandbox override (doctor/tests). When the key is present it wins
   * over `trustedEnv`; `undefined` means "not inside a sandbox".
   */
  activeSandbox?: string;
  /** Print the once-per-process mise shim warnings (default true). */
  warnMiseShims?: boolean;
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

/** Readiness of one chain entry after sandbox-aware evaluation. */
export type HarnessEntryReadiness = "ready" | "warning" | "not-ready";

/**
 * Per-entry outcome of {@link resolveHarnessChain}: what the shared sandbox
 * picker chose for the harness, whether it can start, and whether the chain
 * kept it. Doctors render this directly so their report matches the worker.
 */
export interface HarnessChainEvaluation {
  readonly name: string;
  /** Configured CLI command/path for the entry. */
  readonly path: string;
  /** Absolute executable the command resolves to (or the command when not found). */
  readonly resolvedPath: string;
  readonly installed: boolean;
  /**
   * Shared sandbox decision for this harness. Undefined when no decision was
   * taken (test probe override, or detection itself failed and the probe
   * failed open).
   */
  readonly sandbox?: HarnessSandboxDecision;
  /** Operator-facing effective sandbox label (`nono`, `nono (inherited)`, …). */
  readonly sandboxLabel: string;
  readonly status: HarnessEntryReadiness;
  /** Why the entry is not ready, or the warning to show. */
  readonly reason?: string;
  /** Exact configuration fix for a non-ready/warning entry. */
  readonly hint?: string;
  /** Whether the entry remains in the usable chain. */
  readonly retained: boolean;
  /** Generic-profile note when nono wraps a harness without its pack profile. */
  readonly packNote?: string;
  /** Mise shim detected at the resolved path. */
  readonly miseShim?: MiseShimInfo;
}

/**
 * Build the actionable issue for a harness that failed its sandbox probe.
 *
 * When the shared picker itself refused the harness (an explicit provider
 * that cannot wrap it), the decision message already names the sandbox, the
 * harness and the fixes; pinning the CLI path cannot fix that mismatch, so
 * the CLI_PATH hint is only offered when the harness failed to start under a
 * provider that does support it.
 */
function sandboxIncompatibleIssue(
  entry: HarnessChainEntry,
  providerName: string,
  reason: string,
  kept: "kept" | "dropped",
  decision?: HarnessSandboxDecision,
): HarnessChainIssue {
  const tail =
    kept === "kept"
      ? " Keeping it as the primary entry because no other harness in the chain can start."
      : " Skipping it.";
  if (decision?.kind === "error") {
    return {
      requested: entry.name,
      reason: "sandbox-incompatible",
      message: `Harness "${entry.name}" cannot run under AGENT_SANDBOX=${decision.requested}: ${decision.message}${tail}`,
    };
  }
  const fix = `${harnessCliPathEnvKey(entry.name)}=/path/to/${entry.name}`;
  return {
    requested: entry.name,
    reason: "sandbox-incompatible",
    message:
      `Harness "${entry.name}" (${entry.path}) cannot start under the ${providerName} sandbox: ` +
      `${reason}. Pin the real binary with ${fix}, or adjust AGENT_SANDBOX/AGENT_HARNESS.${tail}`,
  };
}

/** Decision for an explicit provider override (tests/doctor). */
function overrideDecision(
  sandboxName: string,
  provider: SandboxProvider,
  harnessName: string,
): HarnessSandboxDecision {
  if (provider.supportsHarness && !provider.supportsHarness(harnessName)) {
    return {
      kind: "error",
      requested: sandboxName,
      harnessName,
      reason: "incompatible",
      provider,
      message: incompatibleSandboxMessage(provider.name, harnessName),
    };
  }
  return {
    kind: "provider",
    requested: sandboxName,
    harnessName,
    provider,
    detection: { available: true },
  };
}

/**
 * Resolve the priority-ordered harness chain from a comma-separated value.
 *
 * Unknown names and (when `checkInstalled`) not-installed CLIs are reported in
 * `issues` and skipped; if nothing survives, the full parsed list is kept so
 * spawning fails with the familiar actionable error instead of an empty chain.
 *
 * When a sandbox is configured, each entry gets its own decision from the
 * shared picker ({@link decideHarnessSandbox}, the same one `resolveSandbox`
 * uses at spawn time), so `auto` probes `opencode` through the provider that
 * will actually wrap it rather than the primary's provider. Entries that
 * cannot start are dropped with an actionable issue; only when no entry can
 * start is the primary kept (an empty chain is worse). A configuration error
 * that is not harness-specific (unknown/unavailable explicit provider) leaves
 * the chain untouched: the spawn surfaces it. Probe infrastructure errors fail
 * open (the entry is kept with a warning).
 *
 * @param options - Raw value override, installability toggles, and test hooks.
 * @returns The resolved chain with usable entries, dropped-entry issues, and
 *   one evaluation per resolved entry.
 */
// oxlint-disable-next-line complexity -- one branch per decision kind keeps the evaluation in one readable place.
export async function resolveHarnessChain(
  options: HarnessChainOptions = {},
): Promise<ResolvedHarnessChain> {
  const base = resolveHarnessChainSync(options);
  const sandboxName = (options.sandboxName ?? process.env.AGENT_SANDBOX ?? "none").trim() || "none";
  const sandboxed = sandboxName !== "none";
  if (base.entries.length === 0) {
    return { ...base, evaluations: [] };
  }

  // Shim warnings only matter when confinement is active: unsandboxed users
  // can run a mise wrapper just fine.
  if (sandboxed && options.warnMiseShims !== false) {
    for (const entry of base.entries) {
      warnIfMiseShim(entry);
    }
  }

  const activeSandbox = sandboxed
    ? "activeSandbox" in options
      ? options.activeSandbox
      : activeSandboxName(options.trustedEnv)
    : undefined;
  let detections: readonly DetectedSandboxProvider[] | undefined;
  let detectionFailed = false;
  if (sandboxed && !options.probeSandbox && !options.sandboxProvider) {
    try {
      detections = await withExplicitDetection(
        sandboxName,
        options.detections ?? (await detectSandboxProviders()),
      );
    } catch {
      detectionFailed = true;
    }
  }

  const evaluateEntry = async (
    entry: HarnessChainEntry,
  ): Promise<{
    decision?: HarnessSandboxDecision;
    result: HarnessSandboxProbeResult;
    failOpen?: string;
  }> => {
    if (!sandboxed)
      return { decision: { kind: "none", requested: sandboxName }, result: { ok: true } };
    if (options.probeSandbox) {
      if (!entry.installed) return { result: { ok: true } };
      try {
        return { result: await options.probeSandbox({ name: entry.name, path: entry.path }) };
      } catch (error) {
        return { result: { ok: true }, failOpen: (error as Error).message };
      }
    }
    if (detectionFailed) {
      return { result: { ok: true }, failOpen: "sandbox provider detection failed" };
    }
    const decision = options.sandboxProvider
      ? overrideDecision(sandboxName, options.sandboxProvider, entry.name)
      : decideHarnessSandbox({
          sandboxName,
          harnessName: entry.name,
          detections: detections ?? [],
          activeSandbox,
        });
    if (!entry.installed) return { decision, result: { ok: true } };
    try {
      return { decision, result: await probeHarnessForDecision(entry, decision) };
    } catch (error) {
      // Probe infrastructure failure (e.g. provider wrap throws) is not
      // evidence that the harness is unusable — fail open.
      return { decision, result: { ok: true }, failOpen: (error as Error).message };
    }
  };

  const outcomes = await Promise.all(base.entries.map(evaluateEntry));

  // Errors that are not about a specific harness (unknown/removed/unavailable
  // explicit provider) fail every spawn the same way; startup surfaces them.
  // Keep the chain as resolved instead of dropping entries for it.
  const globalError = outcomes.some(
    ({ decision }) => decision?.kind === "error" && decision.reason !== "incompatible",
  );
  const firstPassing = outcomes.findIndex(({ result }) => result.ok);
  const keepIndex = (index: number): boolean =>
    globalError || outcomes[index]!.result.ok || (firstPassing === -1 && index === 0);

  const entries: HarnessChainEntry[] = [];
  const issues = [...base.issues];
  const evaluations: HarnessChainEvaluation[] = [];
  base.entries.forEach((entry, index) => {
    const { decision, result, failOpen } = outcomes[index]!;
    const retained = keepIndex(index);
    if (retained) entries.push(entry);
    const label = decision ? describeSandboxDecision(decision) : sandboxName;
    if (!result.ok && !globalError) {
      issues.push(
        sandboxIncompatibleIssue(
          entry,
          label,
          result.reason,
          retained ? "kept" : "dropped",
          decision,
        ),
      );
    }
    const resolvedPath = resolveExecutablePath(entry.path);
    const shim = detectMiseShim(entry.path);
    const confined = decision?.kind === "provider" || decision?.kind === "inherited";
    // Only a nono wrapper DevIntern adds uses the per-harness pack mapping; an
    // inherited enclosing nono keeps whatever profile it was started with.
    const packStatus =
      decision?.kind === "provider" && decision.provider.name === "nono"
        ? describeNonoPack(entry.name)
        : undefined;

    let status: HarnessEntryReadiness = "ready";
    let reason: string | undefined;
    let hint: string | undefined;
    if (!entry.installed) {
      status = "not-ready";
      reason = `CLI not found ("${entry.path}")`;
      hint = `Install its CLI or set ${harnessCliPathEnvKey(entry.name)} to the executable`;
    } else if (!result.ok) {
      status = "not-ready";
      reason = result.reason;
      hint =
        decision?.kind === "error"
          ? undefined
          : shim.shim
            ? `${miseShimFixHint(entry.name)} (the real executable, not the mise shim)`
            : `set ${miseShimFixHint(entry.name)} to an executable that starts under the sandbox`;
    } else if (shim.shim && (confined || !decision)) {
      status = "warning";
      reason = `resolves to a mise shim (${shim.path}); a sandbox denies its install step`;
      hint = `${miseShimFixHint(entry.name)} (the real executable, not the mise shim)`;
    } else if (decision?.kind === "unsandboxed") {
      // Never present an unsandboxed fallback as plain "ready": `auto` asked
      // for isolation and this harness will run without it.
      status = "warning";
      reason = decision.warning.replace(/^⚠️\s*/u, "");
      hint =
        "Install a provider that supports this harness (nono wraps any harness), " +
        "set AGENT_SANDBOX=none to opt out explicitly, or remove it from AGENT_HARNESS";
    } else if (failOpen) {
      status = "warning";
      reason = `sandbox readiness probe could not run (${failOpen}); kept`;
    }
    evaluations.push({
      name: entry.name,
      path: entry.path,
      resolvedPath,
      installed: entry.installed,
      ...(decision ? { sandbox: decision } : {}),
      sandboxLabel: label,
      status,
      ...(reason ? { reason } : {}),
      ...(hint ? { hint } : {}),
      retained,
      ...(packStatus && !packStatus.packBacked
        ? { packNote: packStatus.note ?? "generic nono profile (no pack profile)" }
        : {}),
      ...(shim.shim ? { miseShim: shim } : {}),
    });
  });

  return { ...base, entries, issues, evaluations };
}
