/**
 * Readiness checks shared by `devintern doctor` and the tail of the
 * `devintern init` wizard: is everything needed for a first successful run
 * present (Bun, git, agent CLI, tracker credentials, sign-in, license,
 * sandbox)?
 *
 * Collection is dependency-injected so it never touches the network or the
 * filesystem in tests; rendering is pure.
 */

import { execSync } from "child_process";
import { getAuthenticatedUser } from "@devintern/auth";
import { checkLicense } from "@devintern/license-check";
import {
  getHarness,
  isHarnessInstalled,
  listHarnesses,
  parseHarnessList,
  resolveHarnessChain,
} from "@devintern/agent-harness";
import type { HarnessEntryReadiness } from "@devintern/agent-harness";
import type { SupabaseAuthConfig } from "@devintern/auth";
import { harnessModelEnvKey, resolveAgentModel } from "../agent/model";
import { TRACKER_CAPABILITIES } from "../trackers/capabilities";
import { signInCommand, workerLoginCommandFor } from "../account/worker-pilot";
import { resolveWorkspaceDir, workspaceConfigPath } from "../workspace/paths";
import { defaultCatalogDir, validateCatalog } from "../automation/catalog";

/**
 * `action`: not broken, but the user has one step to take before it runs
 * (the worker's "sign in to start the Worker Pilot"). Exits 2, not 1.
 */
export type ReadinessStatus = "ok" | "warn" | "action" | "fail";

export interface ReadinessCheck {
  /** Stable identifier (e.g. "git", "agent", "auth"). */
  id: string;
  /** Human-readable check name. */
  label: string;
  status: ReadinessStatus;
  /** One-line detail shown after the label (versions, paths, emails). */
  detail?: string;
  /** Actionable fix hint shown when the check is not ok. */
  hint?: string;
  /** Indented per-item lines (e.g. one per harness chain entry). */
  items?: string[];
}

export interface ReadinessUserLike {
  id: string;
  email: string | null;
}

export interface ReadinessLicenseLike {
  valid: boolean;
  source: string;
  message: string;
}

/** `devintern worker login github`, with `--workspace` for a non-default workspace. */
function defaultSignInCommand(): string {
  return signInCommand(workerLoginCommandFor(workspaceConfigPath(resolveWorkspaceDir())));
}

export interface ReadinessDeps {
  /**
   * Environment snapshot to evaluate tracker credentials against.
   * Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Path of the loaded `.env` file, shown in the tracker detail line. */
  envPath?: string | null;
  /**
   * Supabase auth config for the session and license probes. When omitted
   * (no config resolvable), the auth and license checks are skipped.
   */
  supabaseConfig?: SupabaseAuthConfig;
  getUser?: (config: SupabaseAuthConfig) => Promise<ReadinessUserLike | null>;
  getLicense?: (config: SupabaseAuthConfig) => Promise<ReadinessLicenseLike>;
  /**
   * Sign-in command named in the hint. Defaults to `devintern worker login
   * github` for the workspace the session lives in.
   */
  loginCommand?: string;
  /** Overrides git detection; returns the version string or null. */
  gitVersion?: () => string | null;
  /** Overrides Bun runtime detection; defaults to `process.versions.bun`. */
  bunVersion?: () => string | null;
  /**
   * Overrides the harness chain probe; defaults to the worker's sandbox-aware
   * chain resolution over AGENT_HARNESS / AGENT_SANDBOX.
   */
  probeAgentChain?: () => AgentChainProbeResult | Promise<AgentChainProbeResult>;
  /** Overrides bundled automation-catalog validation; defaults to the real catalog. */
  probeCatalog?: () => CatalogProbeResult;
}

/** Result of validating the bundled automation catalog. */
export interface CatalogProbeResult {
  /** Number of valid packs found. */
  packCount: number;
  /** Broken entries (missing/invalid prompt, duplicate id, bad schedule). */
  errors: string[];
  /** Non-fatal problems (orphaned pack directories). */
  warnings: string[];
}

/** One requested harness chain entry as `devintern doctor` reports it. */
export interface AgentChainEntryReport {
  /** Canonical harness name as requested in AGENT_HARNESS. */
  name: string;
  /** Executable the entry resolves to (absolute when found on PATH). */
  path: string;
  /** Effective sandbox from the shared per-harness picker. */
  sandbox: string;
  /** Effective, harness-scoped model with its source, or "default". */
  model: string;
  status: HarnessEntryReadiness;
  /** Whether the worker keeps the entry in its usable chain. */
  retained: boolean;
  /** Why the entry is excluded, or the warning to act on. */
  reason?: string;
  hint?: string;
  /** Non-fatal notes (nono generic-profile fallback). */
  notes?: string[];
}

/** Sandbox-aware readiness of the whole configured harness chain. */
export interface AgentChainProbeResult {
  /** Effective AGENT_SANDBOX value. */
  sandbox: string;
  entries: AgentChainEntryReport[];
  /** Requested names that are not registered harnesses. */
  unknown: string[];
  /**
   * Every requested name (canonical for known harnesses) in `AGENT_HARNESS`
   * order, unknown names included. `requested[0]` is the primary that
   * interactive and PR-review runs spawn. Defaults to entries then unknown.
   */
  requested?: string[];
  /** Set when the chain cannot be resolved at all (only unknown names). */
  error?: string;
  /** Installed harnesses outside the chain, offered when nothing is usable. */
  alternatives: Array<{ name: string; displayName: string }>;
  /**
   * Set when AGENT_SANDBOX itself is the problem (removed, unknown, or an
   * unavailable explicit provider): every entry fails the same way, so
   * switching AGENT_HARNESS cannot help. Mirrors `globalError` in
   * `resolveHarnessChain`.
   */
  sandboxError?: string;
}

/**
 * Describe the model a harness will run with, scoped to that harness.
 *
 * `<HARNESS>_MODEL` only applies to its own harness and `AGENT_MODEL` only to
 * the primary (see `resolveAgentModel`), so e.g. `OPENCODE_MODEL` is never
 * reported for — or passed to — codex.
 */
function describeEntryModel(name: string, parsed: readonly string[]): string {
  const model = resolveAgentModel(name, parsed);
  if (!model) return "default";
  const key = harnessModelEnvKey(name);
  return `${model} (${process.env[key]?.trim() ? key : "AGENT_MODEL"})`;
}

/**
 * Run `fn` with `env` applied over `process.env`, restoring it afterwards.
 *
 * Chain resolution reads its configuration from `process.env` at every level
 * (`<HARNESS>_CLI_PATH` / `AGENT_CLI_PATH` in path resolution and install
 * checks, `<HARNESS>_MODEL` / `AGENT_MODEL` in model resolution, sandbox
 * detection). The init wizard probes a `.env` it has just written but not
 * loaded, so the whole probe must see that snapshot, not a mix of the two.
 * A no-op when `env` is `process.env` itself.
 */
export async function withEnvOverlay<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  if (env === process.env) return fn();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === value) continue;
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Default chain probe: the worker's own startup resolution
 * (`resolveHarnessChain`), run over every requested entry. Read-only: it
 * executes `<cli> --version` through the sandbox the run would use and never
 * installs, logs in, or changes configuration.
 *
 * @param env - Environment snapshot the whole probe evaluates (AGENT_HARNESS,
 *   AGENT_SANDBOX, CLI path and model overrides). Defaults to `process.env`.
 */
export function defaultAgentChainProbe(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentChainProbeResult> {
  return withEnvOverlay(env, () => probeAgentChainFromProcessEnv(env));
}

async function probeAgentChainFromProcessEnv(
  env: Record<string, string | undefined>,
): Promise<AgentChainProbeResult> {
  const sandbox = env.AGENT_SANDBOX?.trim() || "none";
  const parsed = parseHarnessList(env.AGENT_HARNESS);
  const unknown = parsed.filter((name) => !getHarness(name));
  let chain;
  try {
    chain = await resolveHarnessChain({
      raw: env.AGENT_HARNESS,
      checkInstalled: false,
      warnDeprecated: false,
      warnMiseShims: false,
      sandboxName: sandbox,
      // No `trustedEnv`: the enclosing sandbox must come from the trusted
      // startup snapshot (activeSandboxName's default), exactly as the worker
      // resolves it. `env` may include a repository's `.env`, which must not
      // be able to fake an inherited sandbox.
    });
  } catch (error) {
    return {
      sandbox,
      entries: [],
      unknown,
      error: error instanceof Error ? error.message : String(error),
      alternatives: [],
    };
  }
  const entries = (chain.evaluations ?? []).map((evaluation): AgentChainEntryReport => ({
    name: evaluation.name,
    path: evaluation.resolvedPath,
    sandbox: evaluation.sandboxLabel,
    model: describeEntryModel(evaluation.name, chain.parsed),
    status: evaluation.status,
    retained: evaluation.retained && evaluation.status !== "not-ready",
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    ...(evaluation.hint ? { hint: evaluation.hint } : {}),
    ...(evaluation.packNote ? { notes: [evaluation.packNote] } : {}),
  }));
  const usable = entries.some((entry) => entry.status !== "not-ready");
  // Provider-level errors are not about a specific harness (the same rule as
  // `globalError` in resolveHarnessChain): no other harness would fix them.
  const providerError = (chain.evaluations ?? [])
    .map((evaluation) => evaluation.sandbox)
    .find((decision) => decision?.kind === "error" && decision.reason !== "incompatible");
  const sandboxError = providerError?.kind === "error" ? providerError.message : undefined;
  return {
    sandbox,
    entries,
    unknown,
    requested: parsed,
    ...(sandboxError ? { sandboxError } : {}),
    alternatives:
      usable || sandboxError
        ? []
        : listHarnesses()
            .filter((h) => !chain.parsed.includes(h.name))
            .filter((h) => isHarnessInstalled(h, { includeGlobalCliPath: false }))
            .map((h) => ({ name: h.name, displayName: h.displayName })),
  };
}

const ENTRY_ICON: Record<HarnessEntryReadiness, string> = {
  ready: "✅",
  warning: "⚠️ ",
  "not-ready": "❌",
};

/**
 * Build the agent readiness check from a chain probe.
 *
 * - `ok`: every requested entry is ready.
 * - `warn` (degraded): the primary is usable, but a fallback is excluded,
 *   unknown, or carries a warning (e.g. a mise shim under a sandbox).
 * - `fail`: no requested entry can run, or the primary cannot (including a
 *   primary that is not a registered harness). The worker
 *   would fail over to a usable fallback, but interactive and PR-review runs
 *   spawn only the primary (`resolveHarness()`), so the next such run fails.
 *   This is the same rule `devintern sandbox` exits 1 on.
 */
export function agentChainCheck(probe: AgentChainProbeResult): ReadinessCheck {
  if (probe.error) {
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail: probe.error,
      hint: "Set AGENT_HARNESS to a supported harness name",
    };
  }
  const items: string[] = [];
  // Render in AGENT_HARNESS order so positions match the configured chain;
  // unknown names keep their slot instead of trailing the known entries.
  const requested = probe.requested ?? [
    ...probe.entries.map((entry) => entry.name),
    ...probe.unknown,
  ];
  const byName = new Map(probe.entries.map((entry) => [entry.name, entry]));
  requested.forEach((name, index) => {
    const entry = byName.get(name);
    if (!entry) {
      items.push(`${index + 1}. ❌ ${name} — unknown harness; excluded`);
      return;
    }
    const state =
      entry.status === "ready"
        ? "ready"
        : entry.status === "warning"
          ? `warning: ${entry.reason ?? "check the entry"}`
          : `excluded: ${entry.reason ?? "cannot start"}`;
    items.push(
      `${index + 1}. ${ENTRY_ICON[entry.status]} ${entry.name} — ${entry.path} · sandbox: ${entry.sandbox} · model: ${entry.model} · ${state}`,
    );
    if (entry.hint && entry.status !== "ready") items.push(`   💡 ${entry.hint}`);
    for (const note of entry.notes ?? []) items.push(`   ℹ️  ${note}`);
  });

  const usable = probe.entries.filter((entry) => entry.status !== "not-ready");
  const total = probe.entries.length + probe.unknown.length;
  const chainText = probe.entries.map((entry) => entry.name).join(" → ");
  const sandboxText = `AGENT_SANDBOX=${probe.sandbox}`;
  if (probe.sandboxError) {
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail: `${sandboxText} fails every harness in ${chainText || "AGENT_HARNESS"}: ${probe.sandboxError}`,
      hint: "Fix AGENT_SANDBOX in ~/.devintern/env/<repo>.env or ~/.devintern/.env (e.g. AGENT_SANDBOX=auto, nono, or none); switching AGENT_HARNESS will not help",
      items,
    };
  }
  if (usable.length === 0) {
    const other = probe.alternatives[0];
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail: `no usable harness in ${chainText || "AGENT_HARNESS"} (${sandboxText})`,
      hint: other
        ? `${other.displayName} is installed: set AGENT_HARNESS=${other.name} in ~/.devintern/env/<repo>.env to use it`
        : "Install an agent CLI (e.g. Claude Code) or set <HARNESS>_CLI_PATH to its executable",
      items,
    };
  }
  // The primary is the first requested name, not the first resolved entry:
  // `resolveHarness()` takes the raw first AGENT_HARNESS entry and throws
  // when it is not a registered harness.
  const primaryName = requested[0];
  if (primaryName !== undefined && !byName.has(primaryName)) {
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail:
        `primary ${primaryName} is not a registered harness; the worker falls back to ` +
        `${usable.map((entry) => entry.name).join(" → ")}, but interactive and PR-review ` +
        `runs use the primary and fail`,
      hint: `Fix the first AGENT_HARNESS entry or move a working harness first`,
      items,
    };
  }
  const primary = byName.get(primaryName ?? "");
  if (primary && primary.status === "not-ready") {
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail:
        `primary ${primary.name} cannot start (${sandboxText}); the worker falls back to ` +
        `${usable.map((entry) => entry.name).join(" → ")}, but interactive and PR-review ` +
        `runs use the primary and fail`,
      hint: primary.hint ?? `Fix ${primary.name} or move a working harness first in AGENT_HARNESS`,
      items,
    };
  }
  const fullyReady = usable.length === total && usable.every((entry) => entry.status === "ready");
  if (fullyReady) {
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "ok",
      detail: `${chainText} ready (${sandboxText})`,
      items,
    };
  }
  return {
    id: "agent",
    label: "AI agent CLI",
    status: "warn",
    detail: `degraded — ${usable.length} of ${total} harness chain entries usable (${sandboxText})`,
    hint: "Fix or remove the flagged entries; the worker skips excluded ones",
    items,
  };
}

/** Default catalog probe over the bundled `catalog/` directory. */
function defaultCatalogProbe(): CatalogProbeResult {
  const { packs, issues } = validateCatalog(defaultCatalogDir());
  return {
    packCount: packs.length,
    errors: issues.filter((issue) => issue.level === "error").map((issue) => issue.message),
    warnings: issues.filter((issue) => issue.level === "warn").map((issue) => issue.message),
  };
}

/**
 * Turn a catalog probe into a readiness check. Broken (unusable) entries fail;
 * orphaned directories warn.
 */
function catalogReadinessCheck(catalog: CatalogProbeResult): ReadinessCheck {
  if (catalog.errors.length > 0) {
    return {
      id: "catalog",
      label: "Automation catalog",
      status: "fail",
      detail:
        `${catalog.packCount} valid pack(s); broken: ` + catalog.errors.slice(0, 3).join("; "),
      hint: "Run 'devintern automations list' for details, or reinstall the package",
    };
  }
  if (catalog.warnings.length > 0) {
    return {
      id: "catalog",
      label: "Automation catalog",
      status: "warn",
      detail: `${catalog.packCount} pack(s); orphaned: ` + catalog.warnings.slice(0, 3).join("; "),
      hint: "List every pack in catalog.json or remove the extra directory",
    };
  }
  return {
    id: "catalog",
    label: "Automation catalog",
    status: "ok",
    detail: `${catalog.packCount} pack(s)`,
  };
}

/** Run a catalog probe (injected or default) without letting it throw. */
function safeCatalogCheck(deps: ReadinessDeps): ReadinessCheck {
  try {
    return catalogReadinessCheck(deps.probeCatalog?.() ?? defaultCatalogProbe());
  } catch (error) {
    return {
      id: "catalog",
      label: "Automation catalog",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      hint: "Reinstall @getdevintern/code; the bundled catalog could not be read",
    };
  }
}

/** Detect the installed git version, or null when git is unavailable. */
function detectGitVersion(): string | null {
  try {
    const out = execSync("git --version", { encoding: "utf8", stdio: "pipe" });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Run every readiness check and return them in display order.
 *
 * Network-touching probes (session refresh, license) only run when a
 * Supabase config is provided; everything else is local.
 */
export async function collectReadinessChecks(deps: ReadinessDeps = {}): Promise<ReadinessCheck[]> {
  const env = deps.env ?? process.env;
  const checks: ReadinessCheck[] = [];

  // 1. Runtime
  const bunVersion = deps.bunVersion ? deps.bunVersion() : (process.versions.bun ?? null);
  checks.push(
    bunVersion
      ? { id: "runtime", label: "Bun runtime", status: "ok", detail: `v${bunVersion}` }
      : {
          id: "runtime",
          label: "Bun runtime",
          status: "fail",
          hint: "Install Bun: https://bun.sh",
        },
  );

  // 2. Git
  const git = deps.gitVersion ? deps.gitVersion() : detectGitVersion();
  checks.push(
    git
      ? { id: "git", label: "Git", status: "ok", detail: git.replace(/^git version /, "") }
      : {
          id: "git",
          label: "Git",
          status: "fail",
          hint: "Install git and make sure it is on your PATH",
        },
  );

  // 3. Agent harness chain (every entry, through its effective sandbox)
  try {
    const probe = deps.probeAgentChain
      ? await deps.probeAgentChain()
      : await defaultAgentChainProbe(env);
    checks.push(agentChainCheck(probe));
  } catch (error) {
    checks.push({
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      hint: "Set AGENT_HARNESS to a supported harness name",
    });
  }

  // 4. Tracker credentials
  const trackerType = (env.TASK_TRACKER || "jira").toLowerCase();
  const capabilities = TRACKER_CAPABILITIES[trackerType];
  if (!capabilities) {
    checks.push({
      id: "tracker",
      label: "Task tracker",
      status: "fail",
      detail: `unsupported TASK_TRACKER value "${trackerType}"`,
      hint: `Supported trackers: ${Object.keys(TRACKER_CAPABILITIES).join(", ")}`,
    });
  } else {
    const missing = capabilities.requiredEnv.filter((key) => !env[key]);
    if (missing.length > 0) {
      checks.push({
        id: "tracker",
        label: "Task tracker",
        status: "fail",
        detail: `${capabilities.displayName}: missing ${missing.join(", ")}`,
        hint: "Run 'devintern init' or edit ~/.devintern/env/<repo>.env",
      });
    } else {
      checks.push({
        id: "tracker",
        label: "Task tracker",
        status: "ok",
        detail: capabilities.displayName + (deps.envPath ? ` (${deps.envPath})` : ""),
      });
    }
  }

  // 5. Bundled automation catalog — broken (unusable) entries fail; orphaned
  // directories warn.
  checks.push(safeCatalogCheck(deps));

  // 6. Sign-in session + license (skipped without an auth config)
  if (deps.supabaseConfig) {
    const getUser = deps.getUser ?? getAuthenticatedUser;
    let user: ReadinessUserLike | null = null;
    try {
      user = await getUser(deps.supabaseConfig);
    } catch {
      user = null;
    }

    if (!user) {
      checks.push({
        id: "auth",
        label: "DevIntern sign-in",
        status: "warn",
        hint: `Run \`${deps.loginCommand ?? defaultSignInCommand()}\` — required for worker connect and license entitlements`,
      });
    } else {
      checks.push({
        id: "auth",
        label: "DevIntern sign-in",
        status: "ok",
        detail: user.email || user.id,
      });

      const getLicense =
        deps.getLicense ??
        ((config: SupabaseAuthConfig) =>
          checkLicense({ productKey: "devintern/code", supabaseConfig: config }));
      try {
        const license = await getLicense(deps.supabaseConfig);
        if (license.valid) {
          checks.push({
            id: "license",
            label: "License",
            status: "ok",
            detail: license.source,
          });
        } else {
          checks.push({
            id: "license",
            label: "License",
            status: "warn",
            hint: "Not required for interactive use — only for unattended automation (worker, cron, CI). See https://devintern.com/pricing",
          });
        }
      } catch {
        checks.push({
          id: "license",
          label: "License",
          status: "warn",
          hint: "Could not verify the license right now (offline?)",
        });
      }
    }
  }

  return checks;
}

export interface RenderedReadinessReport {
  lines: string[];
  hasFailures: boolean;
  hasWarnings: boolean;
  /** Some check needs a step from the user (for example signing in); nothing is broken. */
  hasActions: boolean;
}

const STATUS_ICON: Record<ReadinessStatus, string> = {
  ok: "✅",
  warn: "⚠️ ",
  action: "👉",
  fail: "❌",
};

/** Render checks as a checklist with hints. Pure. */
export function renderReadinessReport(checks: ReadinessCheck[]): RenderedReadinessReport {
  const lines: string[] = [];
  let hasFailures = false;
  let hasWarnings = false;
  let hasActions = false;

  for (const check of checks) {
    lines.push(
      `${STATUS_ICON[check.status]} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`,
    );
    for (const item of check.items ?? []) {
      lines.push(`     ${item}`);
    }
    if (check.hint && check.status !== "ok") {
      lines.push(`     💡 ${check.hint}`);
    }
    if (check.status === "fail") hasFailures = true;
    if (check.status === "warn") hasWarnings = true;
    if (check.status === "action") hasActions = true;
  }

  return { lines, hasFailures, hasWarnings, hasActions };
}
