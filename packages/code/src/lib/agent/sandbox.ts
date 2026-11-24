/**
 * Sandbox resolution for agent spawns in @devintern/code.
 *
 * Thin wrapper over `resolveSandbox()` from @devintern/agent-harness that
 * adds the CLI override (`--sandbox <name>`) and memoizes per process so the
 * ~7 spawn sites share one resolution (and the auto-mode warning prints once).
 *
 * Precedence: `--sandbox` flag → `AGENT_SANDBOX` env (workspace env files)
 * → "none". Note .env is loaded once at startup, so a running worker daemon
 * picks up changes on restart, same as AGENT_HARNESS.
 */

import { existsSync } from "fs";

import {
  decideHarnessSandbox,
  detectSandboxProviders,
  pickAutoSandboxProvider,
  resolveHarnessChain,
  resolveSandbox,
} from "@devintern/agent-harness";
import type {
  DetectedSandboxProvider,
  HarnessChainEvaluation,
  HarnessSandboxDecision,
  NonoPackStatus,
  ResolvedSandbox,
  SandboxPolicy,
  SandboxProvider,
} from "@devintern/agent-harness";
import {
  automationsDir,
  injectedTasksDir,
  resolveWorkspaceDir,
  workspaceStateDir,
} from "../workspace/paths";

let cliOverride: string | undefined;
/**
 * Keyed by `<sandbox override>\0<harness>`. A batch or a failover chain can
 * spawn different harnesses, and `auto` picks a provider per harness (the
 * shared picker in `@devintern/agent-harness`: `native` cannot wrap
 * `opencode`/`grok`, `nono` can), so a single shared resolution would wrap
 * the next harness with a provider chosen for the previous one.
 */
const cachedSandboxes = new Map<string, Promise<ResolvedSandbox | null>>();
/** Providers already announced, so a failover onto a new provider is logged once. */
const announcedProviders = new Set<string>();
/**
 * Set when a cached provider failed to wrap a spawn: provider detection is
 * cached per process too, so the next resolution must detect afresh or it
 * would pick the same (now unusable) provider again.
 */
let detectionStale = false;

/**
 * Record the `--sandbox` CLI flag value. Must be called during CLI parsing,
 * before the first {@link getSandbox} call.
 *
 * @param name - Provider name ("none", "auto", "nono", "docker").
 */
export function setSandboxOverride(name: string | undefined): void {
  cliOverride = name;
  resetSandboxResolutionCache();
}

/**
 * Forget memoized sandbox resolutions (configuration reload, tests), so the
 * next spawn re-runs provider selection for its harness.
 */
export function resetSandboxResolutionCache(): void {
  cachedSandboxes.clear();
  announcedProviders.clear();
  detectionStale = false;
}

/**
 * Wrap a resolved sandbox so a failing `wrapCommand` (provider uninstalled,
 * broken, or its policy no longer satisfiable since it was resolved) evicts
 * the memoized resolution. The failing spawn still throws; the next spawn of
 * that harness re-runs provider detection and selection instead of reusing
 * stale state.
 *
 * @param resolved - The resolution being memoized.
 * @param key - Its cache key.
 */
function evictOnWrapFailure(resolved: ResolvedSandbox, key: string): ResolvedSandbox {
  const provider = resolved.provider;
  // Prototype-delegate instead of spreading: providers may be class instances.
  const guarded: SandboxProvider = Object.create(provider);
  guarded.wrapCommand = async (...args: Parameters<SandboxProvider["wrapCommand"]>) => {
    try {
      return await provider.wrapCommand(...args);
    } catch (error) {
      cachedSandboxes.delete(key);
      detectionStale = true;
      throw error;
    }
  };
  return { ...resolved, provider: guarded };
}

/**
 * Resolve the sandbox for agent spawns, memoized per sandbox provider and
 * harness.
 *
 * A failed resolution (explicit provider unusable for the harness) is not
 * memoized: the error is thrown for this spawn and the next spawn resolves
 * again, so a provider installed or fixed meanwhile is picked up. Likewise a
 * memoized provider whose `wrapCommand` fails is evicted and the next spawn
 * re-detects providers. Otherwise availability is snapshotted until the cache
 * is reset (worker failover restart, `--sandbox` override, process restart).
 *
 * @param harnessName - The harness being wrapped, for compatibility filtering.
 * @returns The resolved sandbox, or `null` to spawn the agent directly.
 */
export function getSandbox(harnessName: string): Promise<ResolvedSandbox | null> {
  const key = `${cliOverride ?? ""}\0${harnessName}`;
  let cached = cachedSandboxes.get(key);
  if (!cached) {
    const fresh = detectionStale;
    detectionStale = false;
    const resolution = fresh
      ? detectSandboxProviders({ fresh: true }).then((detections) =>
          resolveSandbox({ sandboxName: cliOverride, harnessName, detections }),
        )
      : resolveSandbox({ sandboxName: cliOverride, harnessName });
    cached = resolution.then(
      (resolved) => {
        if (resolved && !announcedProviders.has(resolved.provider.name)) {
          announcedProviders.add(resolved.provider.name);
          console.log(`🔒 Agent sandbox: ${resolved.provider.displayName}`);
        }
        return resolved ? evictOnWrapFailure(resolved, key) : resolved;
      },
      (error: unknown) => {
        if (cachedSandboxes.get(key) === cached) cachedSandboxes.delete(key);
        throw error;
      },
    );
    cachedSandboxes.set(key, cached);
  }
  return cached;
}

/**
 * Workspace paths a sandboxed agent must be able to write for DevIntern
 * features that live outside the checkout.
 *
 * `devintern worker add` (the documented way for an agent to delegate work —
 * see the devintern-delegate skill) writes a prompt file under `injected/`,
 * inserts a row into `state/queue.db`, and automations advance their cursor
 * under `automations/`. The default sandbox policy only grants the working
 * directory and the task output dir, so without these grants delegation from
 * an agent run fails with a sandbox `EACCES`.
 *
 * Only existing paths are returned: the worker creates the directories it
 * owns at startup, so a run outside workspace mode keeps the default policy
 * untouched.
 *
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 * @returns Existing workspace directories agents may write.
 */
export function workspaceAgentWritablePaths(
  workspaceDir: string = resolveWorkspaceDir(),
): string[] {
  return [
    injectedTasksDir(workspaceDir),
    workspaceStateDir(workspaceDir),
    automationsDir(workspaceDir),
  ].filter((path) => existsSync(path));
}

/**
 * Build the sandbox policy overrides every agent spawn passes to
 * {@link spawnAgent}: the default policy plus the workspace paths agent-facing
 * CLI features need to write.
 *
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`).
 * @returns Policy overrides merged into the provider's default policy.
 */
export function agentSandboxPolicy(
  workspaceDir: string = resolveWorkspaceDir(),
): Partial<SandboxPolicy> {
  return { writablePaths: workspaceAgentWritablePaths(workspaceDir) };
}

/**
 * One-time setup steps and usage caveats per provider that detection cannot
 * probe (external service state, per-user auth). Shown by the doctor so
 * users learn what a first run still needs before it fails.
 */
const PROVIDER_SETUP_NOTES: Record<string, (linux: boolean) => string[]> = {
  native: () => [
    "confines shell commands and their children; for a boundary around the whole agent process use nono",
  ],
  nono: () => [
    "one-time per agent: nono pull nolabs-ai/<agent> (packs: claude, codex, opencode, goose, pi, antigravity)",
  ],
  docker: (linux) => [
    "one-time: sbx policy init balanced" + (linux ? "" : " (after sbx login)"),
    "agent auth: sbx secret set -g anthropic — host logins are not visible inside the VM",
    "not compatible with /tmp working dirs (review worktrees); use nono for those",
  ],
};

/**
 * Render the per-provider block ("Providers on this machine").
 *
 * @param detections - Detected providers.
 * @param harnessName - The configured harness, for compatibility filtering.
 * @param linux - Whether the host is Linux (platform-specific setup notes).
 * @returns The report lines for the provider block.
 */
function describeProviders(
  detections: DetectedSandboxProvider[],
  harnessName: string,
  linux: boolean,
): string[] {
  const lines: string[] = ["Providers on this machine:\n"];
  for (const { provider, detection } of detections) {
    const notes: string[] = [];
    if (provider.priority <= 0) notes.push("explicit-only, never picked by auto");
    if (provider.supportsHarness && !provider.supportsHarness(harnessName)) {
      notes.push(`does not support the configured "${harnessName}" harness`);
    }
    const noteText = notes.length > 0 ? ` [${notes.join("; ")}]` : "";
    lines.push(`  ${provider.name.padEnd(8)} ${provider.displayName}${noteText}`);

    // Some providers append an actionable hint to the version string
    // ("0.69.0 — install the Claude pack..."); split it onto its own line.
    const [version, ...versionHints] = (detection.version ?? "").split(" — ");
    const status = detection.available
      ? `✅ available${version ? ` (${version})` : ""}`
      : `❌ ${detection.reason ?? "unavailable"}`;
    lines.push(`  ${" ".repeat(8)} ${status}`);
    for (const hint of versionHints) {
      lines.push(`  ${" ".repeat(8)} ⚠ ${hint}`);
    }
    for (const step of PROVIDER_SETUP_NOTES[provider.name]?.(linux) ?? []) {
      lines.push(`  ${" ".repeat(8)} setup: ${step}`);
    }
    if (provider.docsUrl) {
      lines.push(`  ${" ".repeat(8)} docs: ${provider.docsUrl}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Render the nono pack-profile status per harness chain entry.
 *
 * A pack-backed harness runs with the pack's grants (Keychain access on
 * macOS, agent-specific rules); the rest fall back to the generic profile
 * plus DevIntern's explicit grants.
 *
 * @param packStatuses - Pack status per chain entry.
 * @returns The report lines for the pack block (empty when there is nothing to show).
 */
function describeNonoPacks(packStatuses: NonoPackStatus[]): string[] {
  if (packStatuses.length === 0) return [];
  const lines: string[] = ["", "nono pack profiles (per harness chain entry):"];
  for (const status of packStatuses) {
    const text = status.packBacked
      ? `pack profile "${status.profile}"`
      : (status.note ?? "no pack profile");
    lines.push(`  ${status.harnessName.padEnd(14)} ${status.packBacked ? "✅" : "⚠"} ${text}`);
  }
  return lines;
}

export interface SandboxDoctorReport {
  lines: string[];
  /** True when the configured provider would make the next run fail. */
  nextRunFails: boolean;
}

/** One harness entry in the doctor's sandbox preflight table. */
export interface HarnessPreflightEntry {
  name: string;
  path: string;
  ok: boolean;
  /** Effective sandbox for this harness (shared picker label). */
  sandbox?: string;
  /** First actionable failure line when `ok` is false. */
  reason?: string;
  /** Exact configuration fix to show under a failing row. */
  suggestion?: string;
  /** Non-fatal notes: mise shim risk, nono generic-profile fallback. */
  warnings?: string[];
}

/** Preflight results collected before rendering the (pure) doctor report. */
export interface HarnessPreflightReport {
  /**
   * Sandbox the entries were probed through: the provider name when every
   * runnable entry shares one (`"<active> (inherited)"` inside an enclosing
   * sandbox), or `"auto (per harness)"` when `auto` picks different providers.
   */
  provider: string;
  entries: HarnessPreflightEntry[];
  /**
   * Fail-open fallback: set only when the inherited probe infrastructure itself
   * cannot run, so the report says probing was skipped instead of failing the
   * doctor.
   */
  skipped?: { activeSandbox: string };
}

/**
 * Map a sandbox-aware chain evaluation to a doctor preflight row.
 *
 * @param evaluation - Evaluation produced by `resolveHarnessChain`.
 */
export function preflightEntryFromEvaluation(
  evaluation: HarnessChainEvaluation,
): HarnessPreflightEntry {
  const warnings: string[] = [];
  if (evaluation.status === "warning" && evaluation.reason) {
    warnings.push(`${evaluation.reason}${evaluation.hint ? ` → ${evaluation.hint}` : ""}`);
  }
  if (evaluation.packNote) warnings.push(evaluation.packNote);
  const ok = evaluation.status !== "not-ready";
  return {
    name: evaluation.name,
    path: evaluation.resolvedPath,
    ok,
    sandbox: evaluation.sandboxLabel,
    ...(!ok && evaluation.reason ? { reason: evaluation.reason } : {}),
    ...(!ok && evaluation.hint ? { suggestion: evaluation.hint } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Probe every configured harness CLI through the sandbox the next run will
 * use for it.
 *
 * This is the worker's own startup chain resolution (`resolveHarnessChain`,
 * which uses the shared per-harness sandbox picker), run over every entry
 * including fallbacks the runtime would drop, so the doctor and the worker
 * cannot disagree. {@link buildSandboxDoctorReport} stays pure and only
 * renders the result.
 *
 * @param configured - Effective `AGENT_SANDBOX` value.
 * @param detections - Provider detections already gathered by the doctor.
 * @param raw - Raw `AGENT_HARNESS` value (defaults to the environment).
 * @param activeSandbox - Enclosing sandbox name from `activeSandboxName()`, if any.
 * @returns Preflight rows, or undefined when nothing is sandboxed or the
 *   configured provider itself is unusable (the "Next run" line reports that).
 */
export async function collectHarnessPreflight(
  configured: string,
  detections: DetectedSandboxProvider[],
  raw?: string,
  activeSandbox?: string,
): Promise<HarnessPreflightReport | undefined> {
  if (!configured || configured === "none") {
    return undefined;
  }

  const chain = await resolveHarnessChain({
    raw,
    checkInstalled: false,
    warnDeprecated: false,
    warnMiseShims: false,
    sandboxName: configured,
    detections,
    activeSandbox,
  });
  const evaluations = chain.evaluations ?? [];
  const decisions = evaluations.map((evaluation) => evaluation.sandbox);
  // A provider-level error (unknown/removed/unavailable) fails every run the
  // same way and is reported by the "Next run" line; nothing to probe.
  if (decisions.some((d) => d?.kind === "error" && d.reason !== "incompatible")) {
    return undefined;
  }
  // Nothing confines any entry: there is no sandbox preflight to show.
  if (decisions.every((d) => d?.kind === "none" || d?.kind === "unsandboxed")) {
    return undefined;
  }

  const runnable = new Set(
    evaluations.filter((e) => e.sandbox?.kind !== "error").map((e) => e.sandboxLabel),
  );
  const provider =
    runnable.size === 1
      ? [...runnable][0]!
      : runnable.size === 0
        ? configured
        : configured === "auto"
          ? "auto (per harness)"
          : `${configured} (per harness)`;
  return { provider, entries: evaluations.map(preflightEntryFromEvaluation) };
}

/** Optional extras for {@link buildSandboxDoctorReport}. */
export interface SandboxDoctorExtras {
  /**
   * Name of the sandbox already wrapping this process, if any. When set and the
   * configured provider cannot nest ({@link SandboxProvider.canNestInSandbox} is
   * falsy), the resolver skips adding another provider, so the report must
   * describe the inherited confinement instead of the configured pick.
   */
  activeSandbox?: string;
  /**
   * Known harness names of the configured chain (`AGENT_HARNESS`), in
   * priority order. `auto` picks a provider per harness, so the "Next run"
   * line names the decision for each entry. Defaults to `[harnessName]`.
   */
  harnessChain?: string[];
  /**
   * First `AGENT_HARNESS` entry when it is not a registered harness.
   * `resolveHarness()` throws on it, so interactive and PR-review runs fail
   * even though the worker would skip it; the report then exits non-zero.
   */
  unknownPrimary?: string;
  /**
   * nono pack-profile status per harness chain entry, so the report can show
   * which runs are pack-backed and which fall back to the generic profile.
   * Probing is done by the caller (this stays pure).
   */
  packStatuses?: NonoPackStatus[];
  /**
   * Collected harness readiness results, rendered as a per-entry table
   * without executing anything in this function.
   */
  preflight?: HarnessPreflightReport;
}

/**
 * Operator-facing "Next run" text for one shared-picker decision.
 *
 * Rendering only: the decision itself comes from `decideHarnessSandbox`.
 *
 * @param decision - Decision for one harness.
 * @param detections - Provider detections (for unavailable reasons and the
 *   list of valid provider names).
 * @returns The text after `Next run:` plus optional continuation lines.
 */
function describeNextRunDecision(
  decision: HarnessSandboxDecision,
  detections: readonly DetectedSandboxProvider[],
): { text: string; more: string[] } {
  switch (decision.kind) {
    case "none":
      return { text: "agents run unsandboxed (sandboxing is off)", more: [] };
    case "unsandboxed":
      return {
        text: "auto finds no usable provider — the run proceeds unsandboxed with a warning",
        more: [],
      };
    case "inherited":
      return {
        text:
          `already inside the ${decision.activeSandbox} sandbox — no additional sandbox will be added` +
          (decision.provider ? "; the agent inherits the existing confinement" : ""),
        more: [],
      };
    case "provider":
      return {
        text:
          decision.requested === "auto"
            ? `auto picks ${decision.provider.name} — agent wrapped with ${decision.provider.displayName}`
            : `agent wrapped with ${decision.provider.displayName}`,
        more: [],
      };
    case "error":
      switch (decision.reason) {
        case "removed":
          return { text: `❌ fails — ${decision.message}`, more: [] };
        case "unknown":
          return {
            text:
              `❌ fails — unknown provider "${decision.requested}". Valid: none, auto, ` +
              detections.map((d) => d.provider.name).join(", "),
            more: [],
          };
        case "unavailable": {
          const detection = detections.find((d) => d.provider.name === decision.requested);
          return {
            text:
              `❌ fails — ${decision.requested} is not usable on this machine ` +
              "(an explicit provider is never silently skipped):",
            more: [detection?.detection.reason ?? "unavailable"],
          };
        }
        case "incompatible":
          return {
            text:
              `❌ fails — ${decision.requested} does not support the configured ` +
              `"${decision.harnessName}" harness. Use AGENT_SANDBOX=auto (picks a compatible ` +
              `provider per harness) or nono (any harness), or switch AGENT_HARNESS.`,
            more: [],
          };
      }
  }
}

/**
 * Render the "Next run" block for every chain entry's decision.
 *
 * Collapses to one line when every entry gets the same outcome (always the
 * case for a single harness or a provider-level error), otherwise lists the
 * decision per harness, so `auto` never names only the primary's provider.
 */
function describeNextRun(
  decisions: HarnessSandboxDecision[],
  detections: readonly DetectedSandboxProvider[],
): string[] {
  const rendered = decisions.map((decision) => describeNextRunDecision(decision, detections));
  const indent = " ".repeat(12);
  const providerError = decisions.findIndex(
    (d) => d.kind === "error" && d.reason !== "incompatible",
  );
  const uniform = rendered.every(
    (r) => r.text === rendered[0]!.text && r.more.join() === rendered[0]!.more.join(),
  );
  if (uniform || providerError !== -1) {
    const r = rendered[providerError === -1 ? 0 : providerError]!;
    return [`Next run:   ${r.text}`, ...r.more.map((line) => `${indent}${line}`)];
  }
  const width = Math.max(...decisions.map((d) => (d.harnessName ?? "").length));
  const lines = ["Next run:   per harness (each entry gets its own sandbox decision):"];
  decisions.forEach((decision, index) => {
    const r = rendered[index]!;
    lines.push(`${indent}${(decision.harnessName ?? "").padEnd(width)}  ${r.text}`);
    lines.push(...r.more.map((line) => `${indent}${" ".repeat(width + 2)}${line}`));
  });
  if (decisions.some((d) => d.kind === "error") && !decisions.every((d) => d.kind === "error")) {
    lines.push(
      decisions[0]!.kind === "error"
        ? `${indent}→ the worker skips failing entries, but interactive and PR-review runs ` +
            `use the primary (${decisions[0]!.harnessName}) and fail`
        : `${indent}⚠ the worker skips failing fallback entries; interactive and PR-review ` +
            `runs use the primary`,
    );
  }
  return lines;
}

/** Report line for a first AGENT_HARNESS entry that is not a registered harness. */
function describeUnknownPrimary(name: string | undefined): string[] {
  if (name === undefined) return [];
  return [
    `Primary:    AGENT_HARNESS entry "${name}" is not a registered harness; ` +
      `interactive and PR-review runs fail (the worker skips it)`,
  ];
}

/**
 * Build the `devintern sandbox` doctor output.
 *
 * Pure over its inputs so it is unit-testable: no detection, env reading, or
 * printing happens here.
 *
 * @param detections - Result of `detectSandboxProviders()`.
 * @param configured - Effective AGENT_SANDBOX value ("none" when unset).
 * @param configuredSource - Where the value came from, for the header line.
 * @param harnessName - The configured harness, for compatibility filtering.
 * @param platform - `process.platform`; injected for tests.
 * @param extras - Optional extras: the enclosing sandbox name, the nono
 *   pack-profile status per harness chain entry, and collected harness
 *   readiness results.
 */
// oxlint-disable-next-line max-params -- positional signature kept for existing callers.
export function buildSandboxDoctorReport(
  detections: DetectedSandboxProvider[],
  configured: string,
  configuredSource: string,
  harnessName: string,
  platform: string = process.platform,
  extras: SandboxDoctorExtras = {},
): SandboxDoctorReport {
  const { activeSandbox, packStatuses = [], preflight } = extras;
  const lines: string[] = [];
  const linux = platform === "linux";
  const chain = extras.harnessChain?.length ? [...new Set(extras.harnessChain)] : [harnessName];

  // What the next agent run will actually do with the current configuration.
  // Every entry is decided by the shared picker (`decideHarnessSandbox`), the
  // same one runtime spawns and the worker chain preflight use, so this line
  // cannot drift from what actually wraps each harness.
  lines.push(`Configured: AGENT_SANDBOX=${configured} (${configuredSource})`);
  const unknownPrimaryLines = describeUnknownPrimary(extras.unknownPrimary);
  lines.push(...unknownPrimaryLines);
  let nextRunFails = unknownPrimaryLines.length > 0;
  if (configured === "none") {
    lines.push("Next run:   agents run unsandboxed (sandboxing is off)");
    const suggestion = pickAutoSandboxProvider(detections, chain[0]);
    if (suggestion) {
      lines.push(
        `            → ${suggestion.provider.name} is installed and ready; enable it with ` +
          `AGENT_SANDBOX=${suggestion.provider.name} (or AGENT_SANDBOX=auto)`,
      );
    }
  } else {
    const decisions = chain.map((name) =>
      decideHarnessSandbox({
        sandboxName: configured,
        harnessName: name,
        detections,
        activeSandbox,
      }),
    );
    // A provider-level error (removed/unknown/unavailable) fails every spawn.
    // Interactive and PR-review runs spawn only the primary entry
    // (`resolveHarness()` uses the first AGENT_HARNESS entry), so a primary
    // the provider cannot wrap fails the next run even though the worker
    // would skip it and run a fallback.
    nextRunFails =
      decisions.some((d) => d.kind === "error" && d.reason !== "incompatible") ||
      decisions[0]?.kind === "error";
    lines.push(...describeNextRun(decisions, detections));
  }
  lines.push("");

  lines.push(...describeProviders(detections, harnessName, linux));

  if (preflight?.skipped) {
    lines.push(
      `Harness CLI preflight: skipped — the agent inherits the existing ` +
        `${preflight.skipped.activeSandbox} confinement`,
    );
    lines.push("");
  } else if (preflight && preflight.entries.length > 0) {
    lines.push(`Harness CLI preflight (${preflight.provider})`);
    for (const entry of preflight.entries) {
      const status = entry.ok
        ? entry.warnings?.length
          ? "OK (with warnings)"
          : "OK"
        : `FAIL — ${entry.reason ?? "could not start"}`;
      const via =
        entry.sandbox && entry.sandbox !== preflight.provider ? ` [${entry.sandbox}]` : "";
      lines.push(`  ${entry.name.padEnd(9)} ${entry.path.padEnd(44)}${via} ${status}`);
      if (!entry.ok && entry.suggestion) {
        lines.push(`  ${" ".repeat(9)} → ${entry.suggestion}`);
      }
      for (const warning of entry.warnings ?? []) {
        lines.push(`  ${" ".repeat(9)} ⚠ ${warning}`);
      }
    }
    // The worker drops failing fallbacks while another entry can start, but
    // interactive and PR-review runs spawn only the primary, so a failing
    // primary means the next task hits the same startup error. Failing
    // fallbacks stay warnings (the rows above).
    if (!preflight.entries[0]!.ok) {
      nextRunFails = true;
    } else if (preflight.entries.some((entry) => !entry.ok)) {
      lines.push("  ⚠ failing fallback entries are skipped by the worker; the primary can start");
    }
    lines.push("");
  }

  for (const name of chain) {
    const pick = pickAutoSandboxProvider(detections, name);
    lines.push(
      pick
        ? `AGENT_SANDBOX=auto would pick: ${pick.provider.name} (for ${name})`
        : `AGENT_SANDBOX=auto would run ${name} unsandboxed (no available provider supports it).`,
    );
  }

  // The pack block only makes sense when nono is installed.
  const nonoAvailable = detections.some((d) => d.provider.name === "nono" && d.detection.available);
  if (nonoAvailable) {
    lines.push(...describeNonoPacks(packStatuses));
  }

  lines.push(
    "\nEnable by setting AGENT_SANDBOX in ~/.devintern/env/<repo>.env (or ~/.devintern/.env) or passing --sandbox <name>." +
      "\nProvider setup guide: https://devintern.com/docs/code/sandboxing",
  );
  return { lines, nextRunFails };
}
