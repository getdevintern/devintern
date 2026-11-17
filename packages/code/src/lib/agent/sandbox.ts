/**
 * Sandbox resolution for agent spawns in @devintern/code.
 *
 * Thin wrapper over `resolveSandbox()` from @devintern/agent-harness that
 * adds the CLI override (`--sandbox <name>`) and memoizes per process so the
 * ~7 spawn sites share one resolution (and the auto-mode warning prints once).
 *
 * Precedence: `--sandbox` flag → `AGENT_SANDBOX` env (.devintern-code/.env)
 * → "none". Note .env is loaded once at startup, so a running worker daemon
 * picks up changes on restart, same as AGENT_HARNESS.
 */

import { existsSync } from "fs";

import {
  removedSandboxProviderMessage,
  resolveHarnessChain,
  resolveSandbox,
  sandboxInheritsEnclosingSandbox,
} from "@devintern/agent-harness";
import type {
  DetectedSandboxProvider,
  HarnessChainEvaluation,
  NonoPackStatus,
  ResolvedSandbox,
  SandboxPolicy,
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
}

/**
 * Resolve the sandbox for agent spawns, memoized per sandbox provider and
 * harness.
 *
 * A failed resolution (explicit provider unusable for the harness) is not
 * memoized: the error is thrown for this spawn and the next spawn resolves
 * again, so a provider installed or fixed meanwhile is picked up.
 *
 * @param harnessName - The harness being wrapped, for compatibility filtering.
 * @returns The resolved sandbox, or `null` to spawn the agent directly.
 */
export function getSandbox(harnessName: string): Promise<ResolvedSandbox | null> {
  const key = `${cliOverride ?? ""}\0${harnessName}`;
  let cached = cachedSandboxes.get(key);
  if (!cached) {
    cached = resolveSandbox({ sandboxName: cliOverride, harnessName }).then(
      (resolved) => {
        if (resolved && !announcedProviders.has(resolved.provider.name)) {
          announcedProviders.add(resolved.provider.name);
          console.log(`🔒 Agent sandbox: ${resolved.provider.displayName}`);
        }
        return resolved;
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
// oxlint-disable-next-line max-params, complexity -- positional signature kept for existing callers; one branch per configured provider/next-run combination keeps the report readable.
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
  const usable = (d: DetectedSandboxProvider) =>
    d.detection.available &&
    (!d.provider.supportsHarness || d.provider.supportsHarness(harnessName));
  const autoPick = detections
    .filter((d) => usable(d) && d.provider.priority > 0)
    .sort((a, b) => b.provider.priority - a.provider.priority)[0];

  // What the next agent run will actually do with the current configuration.
  let nextRunFails = false;
  // Shared with the resolver so the doctor, the runtime error and the tests
  // cannot drift; consulted before the generic unknown-provider branch.
  const removedMessage = removedSandboxProviderMessage(configured);
  lines.push(`Configured: AGENT_SANDBOX=${configured} (${configuredSource})`);
  if (configured === "none") {
    lines.push("Next run:   agents run unsandboxed (sandboxing is off)");
    if (autoPick) {
      lines.push(
        `            → ${autoPick.provider.name} is installed and ready; enable it with ` +
          `AGENT_SANDBOX=${autoPick.provider.name} (or AGENT_SANDBOX=auto)`,
      );
    }
  } else if (configured === "auto") {
    lines.push(
      activeSandbox
        ? `Next run:   already inside the ${activeSandbox} sandbox — no additional sandbox will be added`
        : autoPick
          ? `Next run:   auto picks ${autoPick.provider.name} — agent wrapped with ${autoPick.provider.displayName}`
          : "Next run:   auto finds no usable provider — the run proceeds unsandboxed with a warning",
    );
  } else if (removedMessage) {
    nextRunFails = true;
    lines.push(`Next run:   ❌ fails — ${removedMessage}`);
  } else {
    const chosen = detections.find((d) => d.provider.name === configured);
    if (!chosen) {
      nextRunFails = true;
      lines.push(
        `Next run:   ❌ fails — unknown provider "${configured}". Valid: none, auto, ` +
          detections.map((d) => d.provider.name).join(", "),
      );
    } else if (!chosen.detection.available) {
      nextRunFails = true;
      lines.push(
        `Next run:   ❌ fails — ${configured} is not usable on this machine ` +
          "(an explicit provider is never silently skipped):",
      );
      lines.push(`            ${chosen.detection.reason ?? "unavailable"}`);
    } else if (chosen.provider.supportsHarness && !chosen.provider.supportsHarness(harnessName)) {
      nextRunFails = true;
      lines.push(
        `Next run:   ❌ fails — ${configured} does not support the configured ` +
          `"${harnessName}" harness. Use nono (any harness), or switch AGENT_HARNESS.`,
      );
    } else if (
      activeSandbox &&
      sandboxInheritsEnclosingSandbox({ configured, activeSandbox, provider: chosen.provider })
    ) {
      lines.push(
        `Next run:   already inside the ${activeSandbox} sandbox — no additional sandbox ` +
          "will be added; the agent inherits the existing confinement",
      );
    } else {
      lines.push(`Next run:   agent wrapped with ${chosen.provider.displayName}`);
    }
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
    // Failing entries are dropped at runtime while another can start; the
    // next task only fails when no entry in the chain can start.
    if (!preflight.entries.some((entry) => entry.ok)) {
      nextRunFails = true;
    }
    lines.push("");
  }

  lines.push(
    autoPick
      ? `AGENT_SANDBOX=auto would pick: ${autoPick.provider.name} (for AGENT_HARNESS=${harnessName})`
      : `AGENT_SANDBOX=auto would run unsandboxed (no provider available for AGENT_HARNESS=${harnessName}).`,
  );

  // The pack block only makes sense when nono is installed.
  const nonoAvailable = detections.some((d) => d.provider.name === "nono" && d.detection.available);
  if (nonoAvailable) {
    lines.push(...describeNonoPacks(packStatuses));
  }

  lines.push(
    "\nEnable by setting AGENT_SANDBOX in .devintern-code/.env or passing --sandbox <name>." +
      "\nProvider setup guide: https://devintern.com/docs/code/configuration#sandboxing-the-agent",
  );
  return { lines, nextRunFails };
}
