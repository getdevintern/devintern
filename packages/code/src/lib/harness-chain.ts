/**
 * AGENT_HARNESS fallback-chain parsing and per-candidate resolution.
 *
 * `AGENT_HARNESS` accepts either a single harness id (existing behavior) or
 * an ordered, comma-separated list of candidates such as
 * `claude-code,codex,opencode`. Candidates are attempted in priority order;
 * see {@link HarnessFallbackCoordinator} for the run-level switching policy.
 *
 * Parsing rules:
 *   - Entries are trimmed; surrounding whitespace is ignored.
 *   - Aliases resolve via the shared registry (`agy`/deprecated `gemini` →
 *     `antigravity`) exactly like single-value resolution.
 *   - Empty entries and unknown ids fail validation before any task runs,
 *     identifying the invalid value plus the supported harnesses.
 *   - Duplicate canonical names are attempted only once (first occurrence
 *     wins); the raw alias spelling is preserved for path resolution so
 *     legacy env vars keep working.
 *
 * Path resolution per candidate:
 *   - The primary candidate honors `--agent-path` / `AGENT_CLI_PATH`
 *     (existing single-value semantics).
 *   - Fallback candidates resolve independently via their own
 *     `<HARNESS>_CLI_PATH` variable and default command; a primary-specific
 *     executable path is never reused.
 */

import {
  getHarness,
  getHarnessCliCommand,
  HARNESS_ALIASES,
  listHarnesses,
} from "@devintern/agent-harness";
import type { ResolvedHarness } from "@devintern/agent-harness";

/** One parsed AGENT_HARNESS entry. */
export interface HarnessChainEntry {
  /** Trimmed value exactly as configured (pre-alias), used for resolution. */
  raw: string;
  /** Canonical registry name after alias resolution; used for dedupe/reporting. */
  canonical: string;
}

/** A fully resolved candidate from the configured chain. */
export interface HarnessCandidate {
  entry: HarnessChainEntry;
  /** Zero-based position in the configured order (post-dedupe). */
  position: number;
  resolved: ResolvedHarness;
  /** True when this is the first candidate (AGENT_CLI_PATH applies). */
  isPrimary: boolean;
}

/** Thrown before task execution when AGENT_HARNESS cannot be validated. */
export class HarnessChainValidationError extends Error {
  /** The offending entry as configured. */
  readonly invalidValue: string;

  constructor(invalidValue: string, message: string) {
    super(message);
    this.name = "HarnessChainValidationError";
    this.invalidValue = invalidValue;
  }
}

/** Alias spellings that already emitted a deprecation warning this process. */
const deprecatedWarned = new Set<string>();

/**
 * Emit a deprecated-alias warning once per alias spelling per process.
 *
 * @param entry - Configured (pre-alias) value.
 */
function warnDeprecatedAliasOnce(entry: string): void {
  const alias = HARNESS_ALIASES[entry];
  if (!alias?.deprecated || !alias.warning || deprecatedWarned.has(entry)) {
    return;
  }
  deprecatedWarned.add(entry);
  console.warn(`⚠️  ${alias.warning}`);
}

/**
 * Emit deprecation warnings for every aliased entry in a parsed chain.
 *
 * Single-value chains skip this: the historical `resolveHarness` path emits
 * its own warning, and double-warning the same value would be noise. Chains
 * with multiple candidates bypass that path, so they call this explicitly.
 *
 * @param entries - Parsed chain from {@link parseHarnessChain}.
 */
export function warnDeprecatedChainAliases(entries: HarnessChainEntry[]): void {
  for (const { raw } of entries) {
    warnDeprecatedAliasOnce(raw);
  }
}

function availableHarnessNames(): string {
  return listHarnesses()
    .map((h) => `"${h.name}"`)
    .join(", ");
}

/**
 * Parse the `AGENT_HARNESS` value into an ordered, deduplicated chain.
 *
 * @param raw - Raw env value (`undefined` → default `claude-code`, matching
 *              single-value behavior).
 * @param options - Set `warnDeprecated: false` when another component owns
 *                  deprecation warnings (e.g. single-value resolution).
 * @returns Ordered entries; canonical names are unique.
 * @throws {HarnessChainValidationError} On empty or unknown entries.
 */
export function parseHarnessChain(
  raw: string | undefined | null,
  options?: { warnDeprecated?: boolean },
): HarnessChainEntry[] {
  const value = raw?.trim();
  if (!value) {
    return [{ raw: "claude-code", canonical: "claude-code" }];
  }

  const entries: HarnessChainEntry[] = [];
  const seenCanonical = new Set<string>();

  for (const part of value.split(",")) {
    const entry = part.trim();
    if (!entry) {
      throw new HarnessChainValidationError(
        value,
        `AGENT_HARNESS contains an empty entry ("${value}"). Remove empty items or set a single ` +
          `harness id. Supported harnesses: ${availableHarnessNames()}.`,
      );
    }

    if (options?.warnDeprecated !== false) {
      warnDeprecatedAliasOnce(entry);
    }

    const alias = HARNESS_ALIASES[entry];
    const canonical = alias?.target ?? entry;
    if (!getHarness(canonical)) {
      throw new HarnessChainValidationError(
        entry,
        `Unknown agent harness: "${entry}". Supported harnesses: ${availableHarnessNames()}. ` +
          `Fix AGENT_HARNESS (comma-separated list is allowed, e.g. AGENT_HARNESS=claude-code,codex).`,
      );
    }

    if (seenCanonical.has(canonical)) {
      continue;
    }
    seenCanonical.add(canonical);
    entries.push({ raw: entry, canonical });
  }

  return entries;
}

/**
 * Resolve every parsed entry into an executable candidate.
 *
 * The primary keeps existing single-value semantics: `cliPath` override, then
 * `AGENT_CLI_PATH`, then harness-specific env vars, then the default command.
 * Fallbacks ignore `AGENT_CLI_PATH` and the primary's explicit path entirely —
 * each resolves via its own `<HARNESS>_CLI_PATH` variable and default command.
 *
 * Paths are returned unresolved-to-disk on purpose: spawn sites already ride
 * out transient CLI auto-update swaps via `resolveExecutablePathWithRetry`,
 * and a missing binary must surface as a fallback-eligible launch failure
 * rather than a startup abort.
 *
 * @param entries - Parsed chain from {@link parseHarnessChain}.
 * @param options - Optional CLI path override for the primary candidate.
 */
export function resolveHarnessCandidates(
  entries: HarnessChainEntry[],
  options?: { cliPath?: string },
): HarnessCandidate[] {
  return entries.map((entry, position) => {
    const harness = getHarness(entry.canonical);
    if (!harness) {
      // Unreachable when callers go through parseHarnessChain.
      throw new HarnessChainValidationError(
        entry.raw,
        `Unknown agent harness: "${entry.raw}". Supported harnesses: ${availableHarnessNames()}.`,
      );
    }

    // Primary: explicit --agent-path override, then AGENT_CLI_PATH (via
    // includeGlobalCliPath), then harness-specific env vars and defaults.
    const defaultCommand = getHarnessCliCommand(harness, {
      includeGlobalCliPath: position === 0,
      warnDeprecated: false,
    });
    const path = position === 0 && options?.cliPath ? options.cliPath : defaultCommand;

    return {
      entry,
      position,
      isPrimary: position === 0,
      resolved: { harness, path },
    };
  });
}
