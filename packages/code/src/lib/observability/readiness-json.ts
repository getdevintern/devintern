/**
 * Machine-readable readiness shapes shared by `worker init --non-interactive`,
 * `worker doctor --json`, and `worker service install --json`: one check
 * shape (`name`/`label`/`status`/`message`/`hint`), one result vocabulary, one
 * next-step shape, and the next steps that follow a failed or incomplete check.
 *
 * Every next-step `command` runs as written on a host without a terminal:
 * nothing in it waits for a browser or a prompt (`--no-wait`, `--json`), and
 * the background service comes before the foreground worker.
 */

import {
  GITHUB_FINE_GRAINED_PERMISSIONS,
  condenseMessage,
  githubTokenWriteHint,
} from "@devintern/task-trackers";

import {
  OTHER_LOGIN_METHODS,
  WORKER_PILOT_NOT_STARTED,
  workerLoginCommandFor,
  workspaceEnvPrefixFor,
  workspaceFlagFor,
} from "../account/worker-pilot";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
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

/**
 * Stable error code for the first failed check, so a caller can branch on a
 * failure without parsing prose. `undefined` when nothing failed.
 */
export function failureCodeFor(
  checks: readonly { name: string; status: CheckStatus }[],
): string | undefined {
  const failed = checks.find((check) => check.status === "fail");
  if (!failed) return undefined;
  switch (failed.name) {
    case "tracker-auth":
    case "credentials":
    case "github-token":
      return "credentials_rejected";
    case "query":
      return "query_rejected";
    case "repo":
      return "repo_access_denied";
    case "harness":
      return "agent_missing";
    case "entitlement":
      return "not_entitled";
    case "workspace-config":
      return "workspace_config_invalid";
    case "sign-in":
      return "sign_in_failed";
    case "service":
      return "service_start_failed";
    default:
      return "check_failed";
  }
}

/**
 * One remaining step, the same shape in every document. `command` runs as
 * written on the worker host without a terminal, or is the address to open
 * when the step needs a person in a browser (then `url` repeats it).
 */
export interface NextStep {
  /** Stable step id (e.g. `sign-in`, `install-agent`, `fix-query`, `service`). */
  id: string;
  /** What to do and why, in one sentence or two. */
  message: string;
  command: string;
  /** Address to open in a browser when the step needs a person. */
  url?: string;
}

/** @deprecated Use {@link NextStep}. */
export type ReadinessNextStep = NextStep;

const AGENT_DOCS_URL = "https://devintern.com/docs/code/agent-harness";

/**
 * How to install each harness CLI: the npm package (installed with npm when
 * it is on PATH, otherwise with bun) and a standalone installer that needs
 * neither, preferred when npm is missing.
 */
const AGENT_INSTALL: Record<
  string,
  { label: string; npmPackage?: string; standalone?: string; signIn?: string }
> = {
  "claude-code": {
    label: "Claude Code",
    npmPackage: "@anthropic-ai/claude-code",
    standalone: "curl -fsSL https://claude.ai/install.sh | bash",
    signIn: "run `claude` once and finish /login",
  },
  codex: {
    label: "Codex",
    npmPackage: "@openai/codex",
    signIn: "run `codex login`",
  },
  opencode: {
    label: "OpenCode",
    npmPackage: "opencode-ai",
    standalone: "curl -fsSL https://opencode.ai/install | bash",
    signIn: "run `opencode auth login`",
  },
  deepseek: { label: "DeepSeek (reasonix)", npmPackage: "reasonix" },
  grok: { label: "Grok Build", standalone: "https://x.ai/cli" },
};

/** Options for {@link installAgentStep}. */
export interface InstallAgentOptions {
  /** Finds an executable on PATH (tests); defaults to `Bun.which` over `env.PATH`. */
  which?: (command: string) => string | null;
  /** Command to run once the agent is installed (re-check or re-run setup). */
  thenCommand?: string;
}

function defaultWhich(env: Record<string, string | undefined>) {
  return (command: string): string | null =>
    Bun.which(command, env.PATH ? { PATH: env.PATH } : undefined);
}

/**
 * Next step for a failed harness check, for the first `AGENT_HARNESS` entry.
 * Never assumes npm: a Bun-only host gets the standalone installer or
 * `bun install -g`.
 */
export function installAgentStep(
  env: Record<string, string | undefined>,
  options: InstallAgentOptions = {},
): NextStep & { id: "install-agent" } {
  const raw = env.AGENT_HARNESS?.split(",")[0]?.trim().toLowerCase();
  const primary = !raw || raw === "claude" ? "claude-code" : raw;
  const known = AGENT_INSTALL[primary];
  const then = options.thenCommand ?? "devintern worker doctor --json";
  if (!known) {
    return {
      id: "install-agent",
      message: `Install the ${primary} agent CLI on this host (see the agent harness docs), then run \`${then}\``,
      command: AGENT_DOCS_URL,
      url: AGENT_DOCS_URL,
    };
  }
  const which = options.which ?? defaultWhich(env);
  let command: string;
  if (known.npmPackage && which("npm")) command = `npm install -g ${known.npmPackage}`;
  else if (known.standalone) command = known.standalone;
  else if (known.npmPackage) command = `bun install -g ${known.npmPackage}`;
  else command = AGENT_DOCS_URL;
  const signIn = known.signIn
    ? ` A person must sign it in on this host (${known.signIn}); the worker cannot do that for you.`
    : "";
  return {
    id: "install-agent",
    message: `Install the agent CLI (${known.label}) on this host.${signIn} Then run \`${then}\``,
    command,
    ...(/^https?:\/\//.test(command) ? { url: command } : {}),
  };
}

/** `devintern worker login github --no-wait --json` for a workspace. */
export function signInNoWaitCommand(workspaceDir: string, home?: string, noRelay = false): string {
  return `${workerLoginCommandFor(workspaceConfigPath(workspaceDir), home)} github --no-wait --json${noRelay ? " --no-relay" : ""}`;
}

/** `devintern worker service install --json` for a workspace. */
export function serviceInstallCommand(workspaceDir: string, home?: string): string {
  return `${workspaceEnvPrefixFor(workspaceDir, home)}devintern worker service install --json`;
}

/** `devintern worker connect github --no-wait --json` for a workspace. */
export function connectNoWaitCommand(workspaceDir: string, home?: string): string {
  return `devintern worker connect github --no-wait --json${workspaceFlagFor(workspaceConfigPath(workspaceDir), home)}`;
}

/** `devintern worker doctor --json` for a workspace. */
export function doctorCommand(workspaceDir: string, home?: string): string {
  return `devintern worker doctor --json${workspaceFlagFor(workspaceConfigPath(workspaceDir), home)}`;
}

/** The sign-in step: the same id, message, and command form in every document. */
export function signInStep(
  workspaceDir: string,
  home?: string,
  options: { noRelay?: boolean } = {},
): NextStep {
  return {
    id: "sign-in",
    message:
      `${WORKER_PILOT_NOT_STARTED}. The command prints a sign-in url for a person to open and ` +
      `the --complete command to finish on this host. Other methods: ${OTHER_LOGIN_METHODS}. ` +
      "A paid LICENSE_KEY in the workspace .env works instead",
    command: signInNoWaitCommand(workspaceDir, home, options.noRelay),
  };
}

/** The background-service step (the foreground worker is named only as an alternative). */
export function serviceStep(workspaceDir: string, home?: string): NextStep {
  return {
    id: "service",
    message:
      "Install and start the worker as a background service (systemd/launchd); it checks " +
      "readiness first and waits until the worker is running. To run it in the foreground " +
      "instead (blocks this terminal): devintern worker",
    command: serviceInstallCommand(workspaceDir, home),
  };
}

/** The optional relay step; it needs a signed-in workspace. */
export function connectStep(workspaceDir: string, home?: string): NextStep {
  return {
    id: "connect",
    message:
      "Optional, after signing in: pair the relay for instant GitHub events (polling works " +
      "without it). It prints an authorize url for a person to approve the GitHub App",
    command: connectNoWaitCommand(workspaceDir, home),
  };
}

/** Commands that fix a failed check, supplied by the command that ran the checks. */
export interface FixCommands {
  /** Re-run setup with corrected credentials (default: `worker init ... --env-file <path>`). */
  credentials?: string;
  /** Re-run setup with another task query (default: `worker init ... --task-query '<query>'`). */
  query?: string;
  /** Re-check after fixing something outside DevIntern (default: `worker doctor --json`). */
  recheck?: string;
}

function defaultFixCommands(workspaceDir: string, home?: string): Required<FixCommands> {
  const init = `${workspaceEnvPrefixFor(workspaceDir, home)}devintern worker init --non-interactive --yes`;
  return {
    credentials: `${init} --env-file <path> --json`,
    query: `${init} --task-query '<query>' --json`,
    recheck: doctorCommand(workspaceDir, home),
  };
}

function checkSummary(check: ReadinessCheck): string {
  return `${check.label}: ${check.detail ?? "not ready"}${check.hint ? `. ${check.hint}` : ""}`;
}

const GITHUB_TOKEN_SETTINGS_URL = "https://github.com/settings/personal-access-tokens";

/** The fix for one failed check: what to change, and the command that applies or verifies it. */
function fixStep(
  check: ReadinessCheck,
  options: { workspaceDir: string; env: Record<string, string | undefined>; home?: string },
  fixes: Required<FixCommands>,
): NextStep {
  const summary = checkSummary(check);
  switch (check.id) {
    case "entitlement":
      return {
        id: "fix-entitlement",
        message: `${summary}. Buy a license and set LICENSE_KEY in ${workspaceEnvPath(options.workspaceDir)}, then run \`${fixes.recheck}\``,
        command: "https://devintern.com/pricing",
        url: "https://devintern.com/pricing",
      };
    case "tracker-auth":
    case "credentials":
    case "github-token":
      return {
        id: "fix-credentials",
        message: `${summary}. Put corrected credentials in a 0600 file and re-run setup with it`,
        command: fixes.credentials,
      };
    case "query":
      return {
        id: "fix-query",
        message: `${summary}. Re-run setup with a query the tracker accepts`,
        command: fixes.query,
      };
    case "repo": {
      const github = /github/i.test(check.detail ?? "");
      return {
        id: "fix-repo-access",
        message:
          github && !summary.includes(GITHUB_FINE_GRAINED_PERMISSIONS)
            ? `${summary}. ${githubTokenWriteHint()}, then run \`${fixes.recheck}\``
            : `${summary}. Then run \`${fixes.recheck}\``,
        command: github ? GITHUB_TOKEN_SETTINGS_URL : fixes.recheck,
        ...(github ? { url: GITHUB_TOKEN_SETTINGS_URL } : {}),
      };
    }
    case "service":
      // `--start` could not install or start the service: retrying the
      // install (or running in a terminal) is the fix, not a re-check.
      return {
        id: "fix-service",
        message: `${summary}. Fix the cause, then install and start the service again`,
        command: serviceInstallCommand(options.workspaceDir, options.home),
      };
    case "sandbox":
      return {
        id: "fix-sandbox",
        message: `${summary}. \`devintern sandbox\` shows the setup steps`,
        command: "devintern sandbox",
      };
    default:
      return {
        id: `fix-${check.id}`,
        message: `${summary}. Then run \`${fixes.recheck}\``,
        command: fixes.recheck,
      };
  }
}

/**
 * Next steps for checks that are not ready: sign in, install the agent, or the
 * fix for each failed check. Steps with the same id and command are merged.
 * Empty when every check passes or only warns.
 */
export function blockerNextSteps(
  checks: readonly ReadinessCheck[],
  options: {
    workspaceDir: string;
    env: Record<string, string | undefined>;
    home?: string;
    fixes?: FixCommands;
    which?: InstallAgentOptions["which"];
    /** Carry `--no-relay` into the reported sign-in command (init `--no-relay`). */
    noRelay?: boolean;
  },
): NextStep[] {
  const fixes = { ...defaultFixCommands(options.workspaceDir, options.home), ...options.fixes };
  const steps: NextStep[] = [];
  const add = (step: NextStep) => {
    const same = steps.find((s) => s.id === step.id && s.command === step.command);
    if (same) same.message = `${same.message}; ${step.message}`;
    else steps.push(step);
  };
  for (const check of checks) {
    if (check.status !== "action" && check.status !== "fail") continue;
    if (check.id === "entitlement" && check.status === "action") {
      add(signInStep(options.workspaceDir, options.home, { noRelay: options.noRelay }));
    } else if (check.id === "harness" && check.status === "fail") {
      add(installAgentStep(options.env, { which: options.which, thenCommand: fixes.recheck }));
    } else {
      add(fixStep(check, options, fixes));
    }
  }
  return steps;
}

/**
 * Where setup stands, the explicit done signal: `complete` (every check
 * passed and a worker is running), `ready` (every check passed; start the
 * worker), `action_required` (only a step for a person is left), or
 * `not_ready` (a check failed).
 */
export type SetupState = "complete" | "ready" | "action_required" | "not_ready";

/** The setup state and its one-line summary (text output: `Setup: <setup> — <summary>`). */
export function setupStateFor(checks: readonly ReadinessCheck[]): {
  setup: SetupState;
  summary: string;
} {
  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    const labels = [...new Set(failed.map((check) => check.label))].join(", ");
    return {
      setup: "not_ready",
      summary: `${failed.length} check${failed.length === 1 ? "" : "s"} failed (${labels}).`,
    };
  }
  if (checks.some((check) => check.status === "action")) {
    return {
      setup: "action_required",
      summary: "only signing in is left; nothing is broken.",
    };
  }
  const warnings = checks.filter((check) => check.status === "warn").length;
  const withWarnings = warnings > 0 ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : "";
  const worker = checks.find((check) => check.id === "worker");
  if (worker?.status === "ok") {
    return {
      setup: "complete",
      summary: `every check passed${withWarnings} and the worker is ${worker.detail ?? "running"}.`,
    };
  }
  return {
    setup: "ready",
    summary: `every check passed${withWarnings}; start the worker (background service) to finish setup.`,
  };
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
  /** Done signal: `complete` once every check passes and a worker is running. */
  setup: SetupState;
  /** One line saying where setup stands. */
  summary: string;
  /** Set when `result` is `failure`: the first failed check's code. */
  code?: string;
  workspaceDir: string;
  offline: boolean;
  checks: ReportCheck[];
  nextSteps: NextStep[];
}

/**
 * Build the `worker doctor --json` document. Exit code: `readinessExitCode(result)`.
 * Nothing starts or installs: `service` is offered only when no check blocks
 * and no worker is already running.
 */
export function buildWorkerDoctorReport(
  checks: readonly ReadinessCheck[],
  options: {
    workspaceDir: string;
    offline: boolean;
    env: Record<string, string | undefined>;
    home?: string;
    which?: InstallAgentOptions["which"];
  },
): WorkerDoctorReport {
  const reportChecks = checks.map(toReportCheck);
  const result = resultFor(reportChecks);
  const nextSteps = blockerNextSteps(checks, options);
  const running = checks.some((check) => check.id === "worker" && check.status === "ok");
  if (result === "success" && !running) {
    nextSteps.push(serviceStep(options.workspaceDir, options.home));
  }
  const code = failureCodeFor(reportChecks);
  return {
    schema: WORKER_DOCTOR_JSON_SCHEMA,
    version: WORKER_DOCTOR_JSON_VERSION,
    result,
    ...setupStateFor(checks),
    ...(code ? { code } : {}),
    workspaceDir: options.workspaceDir,
    offline: options.offline,
    checks: reportChecks,
    nextSteps,
  };
}
