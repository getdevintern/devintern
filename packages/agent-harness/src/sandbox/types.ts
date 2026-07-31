/**
 * Core types for the sandbox provider abstraction.
 *
 * A sandbox provider rewrites an already-resolved agent invocation
 * (`path` + `args`) into a wrapped command that runs the agent under
 * OS-level isolation. Two provider tiers exist:
 *
 * - Exec wrappers (nono, srt): the wrapper `exec`s the agent in place, so
 *   the process-group reaper in `process-reaper.ts` works unchanged and any
 *   registered harness can be wrapped.
 * - MicroVMs (Docker Sandboxes, SmolVM): the agent runs inside a VM whose
 *   lifetime is decoupled from the CLI process, so these providers restrict
 *   `supportsHarness` to agents available inside the guest and implement
 *   `cleanup()` to stop the VM.
 */

export interface SandboxPolicy {
  /**
   * Directories the agent may write. Callers always include the working
   * directory; the default policy adds the task output dir, the OS tmpdir
   * (worktrees, Chromium profile scratch), and browser cache dirs so agents
   * that launch Playwright/Puppeteer keep working under the sandbox.
   */
  writablePaths: string[];
  /** Extra readable roots beyond the provider's defaults. */
  readablePaths?: string[];
  /**
   * Network policy. "open" keeps egress unrestricted — the agent needs LLM
   * APIs, git push, and package registries, so this is the default. Domain
   * allowlists are enforced only by providers that support them (srt).
   */
  network: "open" | { allowedDomains: string[] };
  /** Absolute path to the directory the agent operates in. */
  workingDir: string;
  /**
   * Name of the harness being wrapped (e.g. "claude-code"). MicroVM providers
   * need it to address the agent by name inside the guest.
   */
  harnessName?: string;
}

/** The rewritten invocation returned by {@link SandboxProvider.wrapCommand}. */
export interface WrappedCommand {
  path: string;
  args: string[];
  /** Env additions the wrapper requires, merged over the spawn env. */
  env?: Record<string, string>;
  /**
   * Per-run teardown for resources that outlive the wrapper CLI process
   * (microVMs). Callers invoke it after the child exits or is reaped.
   * Kept on the wrapped command (not the provider) so concurrent runs
   * through one provider instance clean up independently.
   */
  cleanup?: () => Promise<void>;
}

export interface SandboxDetection {
  available: boolean;
  /** Human-readable reason when unavailable (missing binary, platform, deps). */
  reason?: string;
  version?: string;
}

export interface SandboxProvider {
  /** Machine-readable identifier, e.g. "nono" or "srt". */
  readonly name: string;
  /** Human-readable name, e.g. "Anthropic Sandbox Runtime". */
  readonly displayName: string;
  /**
   * Selection priority for `AGENT_SANDBOX=auto` (higher wins). Providers with
   * priority <= 0 are never picked by auto and must be selected explicitly.
   */
  readonly priority: number;
  /**
   * Official documentation for installing and configuring the sandbox tool.
   * Surfaced by the `devintern sandbox` doctor so users can find setup steps
   * (auth, policies, packs) without leaving the terminal output.
   */
  readonly docsUrl?: string;
  /** Whether the provider is usable on this machine. */
  detect(): Promise<SandboxDetection>;
  /**
   * Restrict which harnesses this provider can wrap. Undefined means all.
   * MicroVM providers set this: only agents installed inside the guest work.
   */
  supportsHarness?(harnessName: string): boolean;
  /**
   * Rewrite the resolved agent invocation into its sandboxed form. The result
   * must be directly spawn()-able (no shell interpretation by the caller).
   */
  wrapCommand(
    path: string,
    args: readonly string[],
    policy: SandboxPolicy,
  ): WrappedCommand | Promise<WrappedCommand>;
}

export interface ResolvedSandbox {
  provider: SandboxProvider;
  detection: SandboxDetection;
  /** Harness name the sandbox was resolved for; threaded into the policy. */
  harnessName?: string;
}
