/**
 * Machine-readable readiness shapes shared by `worker init --non-interactive`,
 * `worker doctor --json`, and `worker service install --json`: one check
 * shape (`name`/`label`/`status`/`message`/`hint`), one result vocabulary, and
 * the next steps that follow a failed or incomplete check.
 */

import { condenseMessage } from "@devintern/task-trackers";

import { WORKER_PILOT_NOT_STARTED, workerLoginCommandFor } from "../account/worker-pilot";
import { workspaceConfigPath } from "../workspace/paths";
import type { ReadinessCheck } from "./readiness";

/** `action`: nothing is broken, one step for the user is left (signing in). */
export type CheckStatus = "pass" | "warn" | "action" | "fail" | "skipped";

/** `action_required` is exit code 2: only a step for the user is left. */
export type ReadinessResult = "success" | "action_required" | "failure";

/** One check in a JSON report. */
export interface ReportCheck {
  /** Stable check name (e.g. `harness`, `query`, `repo`). */
  name: string;
  label: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

/** Map a readiness row to the JSON check shape. */
export function toReportCheck(check: ReadinessCheck): ReportCheck {
  const status: CheckStatus =
    check.status === "ok"
      ? "pass"
      : check.status === "warn" || check.status === "action"
        ? check.status
        : "fail";
  return {
    name: check.id,
    label: check.label,
    status,
    message: condenseMessage(check.detail ?? ""),
    ...(check.hint && status !== "pass" ? { hint: check.hint } : {}),
  };
}

/** `failure` if any check fails, `action_required` if one needs a user step, else `success`. */
export function resultFor(checks: readonly { status: CheckStatus }[]): ReadinessResult {
  if (checks.some((check) => check.status === "fail")) return "failure";
  if (checks.some((check) => check.status === "action")) return "action_required";
  return "success";
}

/** Exit code for a result: 0 success, 2 action required, 1 failure. */
export function readinessExitCode(result: ReadinessResult): number {
  return result === "success" ? 0 : result === "action_required" ? 2 : 1;
}

/** One remaining step. `command` is always a runnable command or a URL, never prose. */
export interface ReadinessNextStep {
  id: string;
  message: string;
  command: string;
}

const AGENT_DOCS_URL = "https://devintern.com/docs/code/agent-harness";

/** Install command or URL per harness; anything else points at the harness docs. */
const AGENT_INSTALL: Record<string, { label: string; command: string }> = {
  "claude-code": { label: "Claude Code", command: "npm install -g @anthropic-ai/claude-code" },
  codex: { label: "Codex", command: "npm install -g @openai/codex" },
  opencode: { label: "OpenCode", command: "npm install -g opencode-ai" },
  deepseek: { label: "DeepSeek (reasonix)", command: "npm i -g reasonix" },
  grok: { label: "Grok Build", command: "https://x.ai/cli" },
};

/** Next step for a failed harness check, for the first `AGENT_HARNESS` entry. */
export function installAgentStep(
  env: Record<string, string | undefined>,
): ReadinessNextStep & { id: "install-agent" } {
  const raw = env.AGENT_HARNESS?.split(",")[0]?.trim().toLowerCase();
  const primary = !raw || raw === "claude" ? "claude-code" : raw;
  const known = AGENT_INSTALL[primary];
  return {
    id: "install-agent",
    message: known
      ? `Install the agent CLI (${known.label}) on this host and sign it in, then re-run \`devintern worker doctor\``
      : `Install the ${primary} agent CLI on this host (see the agent harness docs), then re-run \`devintern worker doctor\``,
    command: known?.command ?? AGENT_DOCS_URL,
  };
}

/** `devintern worker login github --no-wait --json` for a workspace. */
export function signInNoWaitCommand(workspaceDir: string, home?: string): string {
  return `${workerLoginCommandFor(workspaceConfigPath(workspaceDir), home)} github --no-wait --json`;
}

/**
 * Next steps for checks that are not ready: sign-in, install the agent, or
 * re-check after fixing. Empty when every check passes or only warns.
 */
export function blockerNextSteps(
  checks: readonly ReadinessCheck[],
  options: { workspaceDir: string; env: Record<string, string | undefined>; home?: string },
): ReadinessNextStep[] {
  const steps: ReadinessNextStep[] = [];
  for (const check of checks) {
    if (check.status !== "action" && check.status !== "fail") continue;
    if (check.id === "entitlement" && check.status === "action") {
      steps.push({
        id: "sign-in",
        message: `${WORKER_PILOT_NOT_STARTED} (or set LICENSE_KEY). Other methods: google, x, email you@company.com`,
        command: signInNoWaitCommand(options.workspaceDir, options.home),
      });
    } else if (check.id === "harness" && check.status === "fail") {
      steps.push(installAgentStep(options.env));
    } else {
      steps.push({
        id: "fix",
        message: `${check.label}: ${check.detail ?? "not ready"}${check.hint ? `. ${check.hint}` : ""}`,
        command: "devintern worker doctor",
      });
    }
  }
  return steps;
}

/** `schema` value of the `worker doctor --json` document. Bump `version` on breaking changes. */
export const WORKER_DOCTOR_JSON_SCHEMA = "devintern.worker-doctor";
/** Current `worker doctor --json` document version. */
export const WORKER_DOCTOR_JSON_VERSION = 1;

/** The document `devintern worker doctor --json` prints. */
export interface WorkerDoctorReport {
  schema: typeof WORKER_DOCTOR_JSON_SCHEMA;
  version: typeof WORKER_DOCTOR_JSON_VERSION;
  result: ReadinessResult;
  workspaceDir: string;
  offline: boolean;
  checks: ReportCheck[];
  nextSteps: ReadinessNextStep[];
}

/**
 * Build the `worker doctor --json` document. Exit code: `readinessExitCode(result)`.
 * Nothing starts or installs: `start` and `service` are offered only when no
 * check blocks and no worker is already running.
 */
export function buildWorkerDoctorReport(
  checks: readonly ReadinessCheck[],
  options: {
    workspaceDir: string;
    offline: boolean;
    env: Record<string, string | undefined>;
    home?: string;
  },
): WorkerDoctorReport {
  const reportChecks = checks.map(toReportCheck);
  const result = resultFor(reportChecks);
  const nextSteps = blockerNextSteps(checks, options);
  const running = checks.some((check) => check.id === "worker" && check.status === "ok");
  if (result === "success" && !running) {
    nextSteps.push(
      { id: "start", message: "Start the worker in the foreground", command: "devintern worker" },
      {
        id: "service",
        message: "Or install it as a background service (systemd/launchd)",
        command: "devintern worker service install",
      },
    );
  }
  return {
    schema: WORKER_DOCTOR_JSON_SCHEMA,
    version: WORKER_DOCTOR_JSON_VERSION,
    result,
    workspaceDir: options.workspaceDir,
    offline: options.offline,
    checks: reportChecks,
    nextSteps,
  };
}
