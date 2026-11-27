/**
 * The `Agent sandbox` row of `devintern worker doctor`: the same verdict
 * `devintern sandbox` reports as "next run fails", plus a warning when an
 * unattended agent would run with full access to the host.
 */

import {
  activeSandboxName,
  detectSandboxProviders,
  parseHarnessList,
  pickAutoSandboxProvider,
  removedSandboxProviderMessage,
  sandboxInheritsEnclosingSandbox,
} from "@devintern/agent-harness";
import type { DetectedSandboxProvider } from "@devintern/agent-harness";
import { collectHarnessPreflight } from "../agent/sandbox";
import type { ReadinessCheck } from "./readiness";

type Env = Record<string, string | undefined>;

/** Error message without a stack trace. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Injectable seams for {@link defaultCheckSandbox} (tests). */
export interface SandboxCheckOptions {
  /** Provider detection; defaults to `detectSandboxProviders`. */
  detect?: () => Promise<DetectedSandboxProvider[]>;
  /** `process.platform`; defaults to the current platform. */
  platform?: string;
}

const SANDBOX_DOCS_URL = "https://devintern.com/docs/code/sandboxing";

/**
 * Verdict for an unset `AGENT_SANDBOX`: warn when a provider is available or
 * installable here (every built-in provider targets macOS and Linux), so the
 * riskiest default never shows as a green check. Never fails: a warning
 * leaves the setup state and exit code alone.
 */
async function unsetSandboxCheck(
  label: string,
  harnessEnv: string | undefined,
  detect: () => Promise<DetectedSandboxProvider[]>,
  platform: string = process.platform,
): Promise<ReadinessCheck> {
  let detections: DetectedSandboxProvider[] = [];
  try {
    detections = await detect();
  } catch {
    // Detection is advisory here; fall back to the platform gate.
  }
  const ready = pickAutoSandboxProvider(detections, parseHarnessList(harnessEnv)[0]);
  const installable = platform === "darwin" || platform === "linux";
  if (!ready && !installable) {
    return {
      id: "sandbox",
      label,
      status: "ok",
      detail: "none (no sandbox provider supports this platform; agents run unsandboxed)",
    };
  }
  const how = ready
    ? `${ready.provider.name} is ready here: set AGENT_SANDBOX=auto in the workspace .env`
    : "Install a provider and set AGENT_SANDBOX=auto in the workspace .env (run `devintern sandbox` for setup steps)";
  return {
    id: "sandbox",
    label,
    status: "warn",
    detail: "none: agents run unsandboxed with full access to this host",
    hint: `${how}, or AGENT_SANDBOX=none to opt out on purpose. See ${SANDBOX_DOCS_URL}`,
  };
}

/**
 * Default sandbox check: the same verdict `devintern sandbox` reports as
 * "next run fails", plus the harness CLI preflight through the provider.
 */
export async function defaultCheckSandbox(
  env: Env,
  options: SandboxCheckOptions = {},
): Promise<ReadinessCheck> {
  const label = "Agent sandbox";
  const detect = options.detect ?? detectSandboxProviders;
  const configured = env.AGENT_SANDBOX || "none";
  const hint =
    "Set AGENT_SANDBOX in the workspace .env to none, auto, native, nono, or docker; run `devintern sandbox` for setup steps";
  const removed = removedSandboxProviderMessage(configured);
  if (removed) {
    return { id: "sandbox", label, status: "fail", detail: `${configured}: ${removed}`, hint };
  }
  if (configured === "none") {
    // An explicit `AGENT_SANDBOX=none` is a deliberate opt-out; unset is the
    // unattended-agent-with-full-host-access default, which deserves a warning.
    if (env.AGENT_SANDBOX) {
      return {
        id: "sandbox",
        label,
        status: "ok",
        detail: "none (AGENT_SANDBOX=none set on purpose; agents run unsandboxed)",
      };
    }
    return unsetSandboxCheck(label, env.AGENT_HARNESS, detect, options.platform);
  }
  try {
    const detections = await detect();
    const activeSandbox = activeSandboxName();
    if (configured !== "auto") {
      const chosen = detections.find((d) => d.provider.name === configured);
      if (!chosen) {
        const valid = ["none", "auto", ...detections.map((d) => d.provider.name)].join(", ");
        return {
          id: "sandbox",
          label,
          status: "fail",
          detail: `unknown provider "${configured}" (valid: ${valid})`,
          hint,
        };
      }
      if (!chosen.detection.available) {
        return {
          id: "sandbox",
          label,
          status: "fail",
          detail: `${configured} is not usable on this machine: ${chosen.detection.reason ?? "unavailable"}`,
          hint: `Finish the ${configured} setup (see \`devintern sandbox\`) or change AGENT_SANDBOX`,
        };
      }
    }
    const preflight = await collectHarnessPreflight(
      configured,
      detections,
      env.AGENT_HARNESS,
      activeSandbox,
    );
    const primary = preflight?.entries[0];
    if (primary && !primary.ok) {
      return {
        id: "sandbox",
        label,
        status: "fail",
        detail: `${preflight.provider}: ${primary.name} cannot start (${primary.reason ?? "unknown error"})`,
        hint: primary.suggestion ?? hint,
      };
    }
    const inherited =
      activeSandbox && sandboxInheritsEnclosingSandbox({ configured, activeSandbox });
    return {
      id: "sandbox",
      label,
      status: "ok",
      detail: inherited
        ? `${configured} (inherits the enclosing ${activeSandbox} sandbox)`
        : (preflight?.provider ?? configured),
    };
  } catch (error) {
    return { id: "sandbox", label, status: "fail", detail: errorMessage(error), hint };
  }
}
