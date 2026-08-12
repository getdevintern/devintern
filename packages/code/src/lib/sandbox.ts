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
import type { DetectedSandboxProvider, ResolvedSandbox } from "@devintern/agent-harness";

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

export interface SandboxDoctorReport {
  lines: string[];
  /** True when the configured provider would make the next run fail. */
  nextRunFails: boolean;
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
 */
export function buildSandboxDoctorReport(
  detections: DetectedSandboxProvider[],
  configured: string,
  configuredSource: string,
  harnessName: string,
  platform: string = process.platform,
): SandboxDoctorReport {
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
      autoPick
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
    } else {
      lines.push(`Next run:   agent wrapped with ${chosen.provider.displayName}`);
    }
  }
  lines.push("");

  lines.push("Providers on this machine:\n");
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

  lines.push(
    autoPick
      ? `AGENT_SANDBOX=auto would pick: ${autoPick.provider.name} (for AGENT_HARNESS=${harnessName})`
      : `AGENT_SANDBOX=auto would run unsandboxed (no provider available for AGENT_HARNESS=${harnessName}).`,
  );
  lines.push(
    "\nEnable by setting AGENT_SANDBOX in .devintern-code/.env or passing --sandbox <name>." +
      "\nProvider setup guide: https://devintern.com/docs/code/configuration#sandboxing-the-agent",
  );
  return { lines, nextRunFails };
}
