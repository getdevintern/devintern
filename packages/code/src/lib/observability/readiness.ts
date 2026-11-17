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

export type ReadinessStatus = "ok" | "warn" | "fail";

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
  /** Overrides git detection; returns the version string or null. */
  gitVersion?: () => string | null;
  /** Overrides Bun runtime detection; defaults to `process.versions.bun`. */
  bunVersion?: () => string | null;
  /**
   * Overrides the harness chain probe; defaults to the worker's sandbox-aware
   * chain resolution over AGENT_HARNESS / AGENT_SANDBOX.
   */
  probeAgentChain?: () => AgentChainProbeResult | Promise<AgentChainProbeResult>;
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
  /** Set when the chain cannot be resolved at all (only unknown names). */
  error?: string;
  /** Installed harnesses outside the chain, offered when nothing is usable. */
  alternatives: Array<{ name: string; displayName: string }>;
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
 * Default chain probe: the worker's own startup resolution
 * (`resolveHarnessChain`), run over every requested entry. Read-only: it
 * executes `<cli> --version` through the sandbox the run would use and never
 * installs, logs in, or changes configuration.
 *
 * @param env - Environment holding AGENT_HARNESS / AGENT_SANDBOX.
 */
export async function defaultAgentChainProbe(
  env: Record<string, string | undefined> = process.env,
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
  return {
    sandbox,
    entries,
    unknown,
    alternatives: usable
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
 * - `warn` (degraded): at least one entry is usable, but another is excluded,
 *   unknown, or carries a warning (e.g. a mise shim under a sandbox).
 * - `fail`: no requested entry can run.
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
  probe.entries.forEach((entry, index) => {
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
  for (const name of probe.unknown) {
    items.push(`❌ ${name} — unknown harness; excluded`);
  }

  const usable = probe.entries.filter((entry) => entry.status !== "not-ready");
  const total = probe.entries.length + probe.unknown.length;
  const chainText = probe.entries.map((entry) => entry.name).join(" → ");
  const sandboxText = `AGENT_SANDBOX=${probe.sandbox}`;
  if (usable.length === 0) {
    const other = probe.alternatives[0];
    return {
      id: "agent",
      label: "AI agent CLI",
      status: "fail",
      detail: `no usable harness in ${chainText || "AGENT_HARNESS"} (${sandboxText})`,
      hint: other
        ? `${other.displayName} is installed: set AGENT_HARNESS=${other.name} in .devintern-code/.env to use it`
        : "Install an agent CLI (e.g. Claude Code) or set <HARNESS>_CLI_PATH to its executable",
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
        hint: "Run 'devintern init' or edit .devintern-code/.env",
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

  // 5. Sign-in session + license (skipped without an auth config)
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
        hint: "Run 'devintern login' — required for worker connect and license entitlements",
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
}

const STATUS_ICON: Record<ReadinessStatus, string> = {
  ok: "✅",
  warn: "⚠️ ",
  fail: "❌",
};

/** Render checks as a checklist with hints. Pure. */
export function renderReadinessReport(checks: ReadinessCheck[]): RenderedReadinessReport {
  const lines: string[] = [];
  let hasFailures = false;
  let hasWarnings = false;

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
  }

  return { lines, hasFailures, hasWarnings };
}
