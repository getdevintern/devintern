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
  getHarnessCliCommand,
  isHarnessInstalled,
  listHarnesses,
  resolveHarness,
} from "@devintern/agent-harness";
import type { SupabaseAuthConfig } from "@devintern/auth";
import { TRACKER_CAPABILITIES } from "./tracker-capabilities";

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
  /** Overrides agent CLI detection; defaults to registry + PATH probing. */
  probeAgent?: () => AgentProbeResult;
}

export interface AgentProbeResult {
  /** The configured harness resolved successfully (vs unknown name). */
  resolved: boolean;
  resolutionError?: string;
  displayName: string;
  /** Probe command for the configured harness. */
  command: string;
  installed: boolean;
  /** Other registered harnesses with an installed CLI. */
  alternatives: Array<{ name: string; displayName: string }>;
}

/** Default agent probe over the real harness registry and PATH. */
function defaultAgentProbe(): AgentProbeResult {
  const resolved = resolveHarness({ warnDeprecated: false });
  const command = getHarnessCliCommand(resolved.harness, { includeGlobalCliPath: true });
  if (isHarnessInstalled(resolved.harness, { includeGlobalCliPath: true })) {
    return {
      resolved: true,
      displayName: resolved.harness.displayName,
      command,
      installed: true,
      alternatives: [],
    };
  }
  return {
    resolved: true,
    displayName: resolved.harness.displayName,
    command,
    installed: false,
    alternatives: listHarnesses()
      .filter((h) => h.name !== resolved.harness.name)
      .filter((h) => isHarnessInstalled(h, { includeGlobalCliPath: false }))
      .map((h) => ({ name: h.name, displayName: h.displayName })),
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

  // 3. Agent harness CLI
  try {
    const probe = deps.probeAgent?.() ?? defaultAgentProbe();
    if (!probe.resolved) {
      checks.push({
        id: "agent",
        label: "AI agent CLI",
        status: "fail",
        detail: probe.resolutionError,
        hint: "Set AGENT_HARNESS to a supported harness name",
      });
    } else if (probe.installed) {
      checks.push({
        id: "agent",
        label: "AI agent CLI",
        status: "ok",
        detail: `${probe.displayName} (${probe.command})`,
      });
    } else if (probe.alternatives.length > 0) {
      const other = probe.alternatives[0];
      checks.push({
        id: "agent",
        label: "AI agent CLI",
        status: "warn",
        detail:
          `configured "${probe.displayName}" is not installed, but ` + `${other.displayName} is`,
        hint: `Set AGENT_HARNESS=${other.name} in .devintern-code/.env to use it`,
      });
    } else {
      checks.push({
        id: "agent",
        label: "AI agent CLI",
        status: "fail",
        detail: `${probe.displayName} ("${probe.command}") not found on PATH`,
        hint: "Install an agent CLI (e.g. Claude Code) or set AGENT_CLI_PATH to its executable",
      });
    }
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
    if (check.hint && check.status !== "ok") {
      lines.push(`     💡 ${check.hint}`);
    }
    if (check.status === "fail") hasFailures = true;
    if (check.status === "warn") hasWarnings = true;
  }

  return { lines, hasFailures, hasWarnings };
}
