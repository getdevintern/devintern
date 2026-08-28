/**
 * Startup push-permission probe: does the ambient git credential setup
 * actually allow pushing to a GitHub remote?
 *
 * GitHub's read APIs cannot answer this. The collaborator-permission endpoint
 * reports the *user's* role (not what the token itself may do), and
 * fine-grained PATs expose no scopes header — a token with only Contents:
 * Read passes every API check yet fails `git push` with a 403.
 *
 * So we probe through git itself: `git push --dry-run
 * origin HEAD:refs/heads/<probe-ref>` exercises GitHub's real
 * git-receive-pack auth path (the same code a real push takes) without
 * creating any ref. A dry-run is the one faithful, side-effect-free signal,
 * and it also catches credential-precedence surprises: when GITHUB_TOKEN is
 * exported, `gh auth git-credential` serves it in place of the keyring
 * token, so an under-scoped PAT silently overrides a working `gho_…` login.
 */

import { Utils } from "./utils";

export type PushProbeStatus = "ok" | "permission" | "network" | "unknown";

export interface PushProbeResult {
  status: PushProbeStatus;
  /** One-line detail suitable for log output. */
  message: string;
}

/** Ref name used by dry-run probes; never created by --dry-run. */
const PROBE_REF = "__devintern_push_probe__";

/** Default probe timeout; slow auth paths still finish well within it. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Strip embedded basic-auth from remote URLs before surfacing output. */
function redactRemote(message: string): string {
  return message.replace(/https:\/\/[^@/]+@/g, "https://");
}

/**
 * Classify a dry-run push outcome into ok / permission / network / unknown.
 *
 * Permission failures mention the denied user or an HTTP 401/403 from
 * GitHub ("denied to <login>", "The requested URL returned error: 403").
 * Everything DNS/connect/TLS-shaped is network, not a configuration error
 * worth waking the operator up for at startup. Pure; unit-tested.
 */
export function classifyPushProbe(
  success: boolean,
  output: string,
  error?: string,
): PushProbeResult {
  const combined = redactRemote([output, error].filter(Boolean).join("\n").trim());

  if (success) {
    return { status: "ok", message: combined || "dry-run push accepted" };
  }

  if (/denied to\b|permission to .*\.git|\b(?:401|403)\b/i.test(combined)) {
    return {
      status: "permission",
      message: combined.split("\n")[0] ?? "push rejected",
    };
  }

  if (
    /\bcould not resolve host\b|\bfailed to connect\b|\btimed out\b|\bconnection reset\b|\bssl\b|\bcertificate\b/i.test(
      combined,
    )
  ) {
    return {
      status: "network",
      message: combined.split("\n")[0] ?? "network failure",
    };
  }

  return {
    status: "unknown",
    message: combined.split("\n")[0] ?? "unrecognized failure",
  };
}

/**
 * Probe whether the current environment can push to the remote at `cwd`
 * via a side-effect-free dry run against `PROBE_REF`.
 *
 * @param options.cwd - Repository (bare clone or checkout) holding the remote
 * @param options.timeoutMs - Per-probe timeout (default 30s)
 */
export async function probePushAccess(options: {
  cwd: string;
  timeoutMs?: number;
}): Promise<PushProbeResult> {
  const result = await Utils.executeGitCommand(
    ["push", "--dry-run", "origin", `HEAD:refs/heads/${PROBE_REF}`],
    { cwd: options.cwd, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  return classifyPushProbe(result.success, result.output, result.error);
}
