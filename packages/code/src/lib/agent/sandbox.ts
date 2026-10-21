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

import { resolveSandbox } from "@devintern/agent-harness";
import type {
  DetectedSandboxProvider,
  NonoPackStatus,
  ResolvedSandbox,
} from "@devintern/agent-harness";

let cliOverride: string | undefined;
let cached: Promise<ResolvedSandbox | null> | null = null;

/**
 * Record the `--sandbox` CLI flag value. Must be called during CLI parsing,
 * before the first {@link getSandbox} call.
 *
 * @param name - Provider name ("none", "auto", "nono", "srt", "docker", "smolvm").
 */
export function setSandboxOverride(name: string | undefined): void {
  cliOverride = name;
  cached = null;
}

/**
 * Resolve the sandbox for agent spawns, memoized per process.
 *
 * @param harnessName - The harness being wrapped, for compatibility filtering.
 * @returns The resolved sandbox, or `null` to spawn the agent directly.
 */
export function getSandbox(harnessName: string): Promise<ResolvedSandbox | null> {
  if (!cached) {
    cached = resolveSandbox({ sandboxName: cliOverride, harnessName }).then((resolved) => {
      if (resolved) {
        console.log(`🔒 Agent sandbox: ${resolved.provider.displayName}`);
      }
      return resolved;
    });
  }
  return cached;
}

/**
 * One-time setup steps and usage caveats per provider that detection cannot
 * probe (external service state, per-user auth). Shown by the doctor so
 * users learn what a first run still needs before it fails.
 */
const PROVIDER_SETUP_NOTES: Record<string, (linux: boolean) => string[]> = {
  native: () => [
    "confines shell commands and their children; for a boundary around the whole agent process use nono or srt",
  ],
  nono: () => [
    "one-time per agent: nono pull nolabs-ai/<agent> (packs: claude, codex, opencode, goose, pi, antigravity)",
  ],
  srt: () => [
    "network runs on a built-in allowlist of agent essentials; extend it with AGENT_SANDBOX_ALLOWED_DOMAINS",
  ],
  docker: (linux) => [
    "one-time: sbx policy init balanced" + (linux ? "" : " (after sbx login)"),
    "agent auth: sbx secret set -g anthropic — host logins are not visible inside the VM",
    "not compatible with /tmp working dirs (review worktrees); use nono or srt for those",
  ],
  smolvm: (linux) => [
    "first run downloads a guest VM image (several minutes)",
    ...(linux ? ["needs KVM (/dev/kvm) and your distro's QEMU system package"] : []),
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
 * @param extras - Optional extras: the enclosing sandbox name and the nono
 *   pack-profile status per harness chain entry.
 */
export function buildSandboxDoctorReport(
  detections: DetectedSandboxProvider[],
  configured: string,
  configuredSource: string,
  harnessName: string,
  platform: string = process.platform,
  extras: SandboxDoctorExtras = {},
): SandboxDoctorReport {
  const { activeSandbox, packStatuses = [] } = extras;
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
          `"${harnessName}" harness. Use nono or srt (any harness), or switch AGENT_HARNESS.`,
      );
    } else if (activeSandbox && !chosen.provider.canNestInSandbox) {
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
