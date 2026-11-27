/**
 * State of one `devintern worker init` run, shared by both input sources:
 * the interactive wizard (`prompt`) and `--non-interactive` (`flags`). The
 * steps in `worker-init-steps.ts` read their input through one of these runs
 * and record what they did in its {@link SetupOutcome}.
 */

import type { PromptSession } from "../cli/prompt-session";
import type {
  GitHubAppOutcome,
  RelayConnectOutcome,
  ServiceInstallOutcome,
} from "../observability/analytics";
import type { ReadinessCheck } from "../observability/readiness";
import type { WorkerEntitlementLike } from "../observability/worker-readiness";
import type { NextStep } from "../observability/readiness-json";
import type { connectRelayTarget } from "../relay/connect";
import type {
  RunCommandFn,
  ServiceInstallResult,
  ServiceManagerAvailability,
  ServiceState,
} from "../worker/service";
import type { StartCheck } from "../worker/service-control";
import type { AppliedWrite, Plan, PlanDraft } from "./worker-init-noninteractive-plan";
import type {
  Env,
  InitCheck,
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
  NonInteractiveInitReport,
} from "./worker-init-noninteractive-types";
import type { LogFn, PromptFn } from "./worker-init-policy";
import type { SentryValidationOptions } from "./worker-sentry-setup";

export type { GitHubAppOutcome } from "../observability/analytics";

/** Where a step's input comes from: a person answering prompts, or flags and the environment. */
export type InputSource = "prompt" | "flags";

export interface WorkerInitResult {
  ok: boolean;
  /** No failing readiness check (or license problem) is left after setup. */
  ready?: boolean;
  /** Not ready, but only signing in remains (no failing check): exit code 2. */
  signInOnly?: boolean;
}

export interface InitUserLike {
  id: string;
  email: string | null;
}

export interface WorkerInitDeps {
  prompt?: PromptFn;
  /** Hidden-input prompt for tokens; defaults to `prompt` when `prompt` is injected. */
  promptSecret?: PromptFn;
  log?: LogFn;
  cwd?: string;
  /** Evaluate the ready-tasks query; returns the number of matching tasks. */
  dryRunQuery?: (query: string) => Promise<number>;
  /** Automation license check; returns a human-readable failure, or null when entitled. */
  checkAutomationLicense?: (workspaceDir: string) => Promise<string | null>;
  /** Override tracker-config step. Return tracker id, or null to abort. */
  ensureTracker?: (ctx: {
    cwd: string;
    prompt: PromptFn;
    promptSecret: PromptFn;
    log: LogFn;
  }) => Promise<string | null>;
  /**
   * Readiness checks shown at the end (the `worker doctor` checks). Without
   * it the closing line relies on the license step alone.
   */
  collectReadiness?: (workspaceDir: string) => Promise<ReadinessCheck[]>;
  /** Override workspace write. */
  bootstrapWorkspace?: (opts: {
    cwd: string;
    log: LogFn;
  }) => Promise<{ workspaceDir: string; created?: boolean; repoName?: string } | { error: string }>;
  /** Signed-in user lookup for relay onboarding. */
  getUser?: (projectRoot: string, workspaceDir?: string) => Promise<InitUserLike | null>;
  /** Interactive login for relay onboarding. */
  signIn?: (projectRoot: string, workspaceDir?: string) => Promise<InitUserLike | null>;
  /** Register relay sources while persisting state under the workspace home. */
  connectRelay?: (ctx: {
    projectRoot: string;
    workspaceDir: string;
    trackerType: string;
    log: LogFn;
  }) => Promise<boolean>;
  /** Override individual relay target setup while exercising default init orchestration. */
  runRelayConnect?: typeof connectRelayTarget;
  /** Override GitHub remote detection for the App step (`owner/name` or null). */
  detectGithubRepo?: () => Promise<string | null>;
  /** Validate Sentry credentials and project access; returns the current issue count. */
  validateSentry?: (options: SentryValidationOptions) => Promise<number>;
  /** Override the guided workspace operating-policy step. */
  configureOperatingPolicy?: (ctx: {
    workspaceDir: string;
    prompt: PromptFn;
    log: LogFn;
  }) => Promise<void>;
  /**
   * Host checks run before the first question (agent CLI, git, service
   * manager). Without it the wizard skips them and relies on the readiness
   * checks at the end.
   */
  checkHost?: () => Promise<HostChecks>;
  /** Ask the worker settings one by one, plus the Sentry step (CLI `--customize`). */
  customize?: boolean;
  /** Platform override for service-file tests. */
  platform?: NodeJS.Platform;
  /** Worker executable written into service definitions. */
  execPath?: string;
  /** Runtime executable used to launch the worker entrypoint (tests). */
  runtimePath?: string;
  /** PATH inherited by the background service (tests). */
  environmentPath?: string;
  /** File writer override for tests. */
  writeFile?: (path: string, content: string) => void;
  /** Skip the background-service offer entirely (CLI `--no-service`). */
  noService?: boolean;
  /** Home directory for the user-level service paths (tests). */
  homedir?: string;
  /** POSIX uid used by `launchctl gui/<uid>` (tests). */
  uid?: number;
  /** Command runner used by the service install (tests). */
  run?: RunCommandFn;
  /** Override installed/running detection for the service step (tests). */
  detectService?: () => Promise<ServiceState>;
  /** Override the systemd/launchd availability check for the service step (tests). */
  checkServiceManager?: () => Promise<ServiceManagerAvailability>;
  /** Override the whole install-and-launch action (tests). */
  installService?: (ctx: {
    workspaceDir: string;
    execPath: string;
    runtimePath: string;
    environmentPath: string;
    log: LogFn;
  }) => Promise<ServiceInstallResult>;
  /** Override the honest start check after installing (tests). */
  verifyServiceStart?: (ctx: { workspaceDir: string; since: number }) => Promise<StartCheck>;
}

/** What the wizard's host checks found (`worker-init-host.ts`). */
export interface HostChecks {
  /** The `worker doctor` harness check (agent CLI installed and spawnable). */
  harness: ReadinessCheck;
  /** Path of the `git` executable, or null when it is not on PATH. */
  git: string | null;
  /** Whether a background service can be installed; info only. Absent when not checked. */
  serviceManager?: ServiceManagerAvailability;
  /** How to install the agent CLI, when the harness check failed. */
  installAgent?: NextStep;
}

/** The host step's result, read by later steps so they do not repeat it. */
export interface HostReport {
  checks: HostChecks;
  /** The harness failure was already shown; the readiness block refers back to it. */
  harnessReported: boolean;
}

/** Something that keeps the worker from starting; `action` is a step, not a failure. */
export interface ReadinessBlocker {
  text: string;
  action: boolean;
}

export interface ServiceStepResult {
  /** The worker was confirmed running under the service. */
  serviceRunning: boolean;
  /** A service now manages the worker (running, starting, or failed). */
  serviceInstalled?: boolean;
  serviceInstall: ServiceInstallOutcome;
}

/** What the steps did, read by the closing summary (text) and the report (JSON). */
export interface SetupOutcome {
  relayConnected: boolean;
  relayConnect: RelayConnectOutcome;
  githubApp: GitHubAppOutcome;
  /** License step: the problem left, null when entitled, undefined when not checked. */
  licenseFailure?: string | null;
  /** What keeps the worker from running, from the readiness step. */
  blockers: ReadinessBlocker[];
  service: ServiceStepResult;
}

export function emptyOutcome(): SetupOutcome {
  return {
    relayConnected: false,
    relayConnect: "skipped",
    githubApp: "skipped",
    blockers: [],
    service: { serviceRunning: false, serviceInstall: "skipped" },
  };
}

/** The interactive wizard: every input comes from a prompt. */
export interface PromptRun {
  input: "prompt";
  deps: WorkerInitDeps;
  cwd: string;
  projectRoot: string;
  log: LogFn;
  prompt: PromptFn;
  promptSecret: PromptFn;
  /** Turns Ctrl+C during a browser sign-in wait into a prompt abort. */
  guard: PromptSession["guard"];
  /** The user declined (or skipped) sign-in earlier in this run; do not ask again. */
  signInDeclined?: boolean;
  /** Set by the host step when it ran. */
  host?: HostReport;
  /** Set by the tracker step. */
  trackerType: string;
  trackerName: string;
  queryExample?: string;
  /** Set by the workspace step ("" before): what a stopped setup leaves behind. */
  workspaceDir: string;
  repoName?: string;
  outcome: SetupOutcome;
}

/** `--non-interactive`: every input comes from flags and the environment. */
export interface FlagsRun {
  input: "flags";
  args: NonInteractiveInitArgs;
  deps: NonInteractiveInitDeps;
  cwd: string;
  processEnv: Env;
  workspaceDir: string;
  log: LogFn;
  /** Secret values to redact from the report; grows once the plan has the credentials. */
  secrets: string[];
  /** The JSON document; a failed step sets `error` and `code`. */
  report: NonInteractiveInitReport;
  /** Inputs validated so far (tracker and workspace steps). */
  draft?: PlanDraft;
  /** Every input validated (query step on). */
  plan?: Plan;
  /** What the save step wrote, so a failed check can restore it. */
  writes: AppliedWrite[];
  /** The license step's entitlement check; the readiness step reports its verdict. */
  entitlement?: Promise<WorkerEntitlementLike>;
  /** A `--sign-in` that could not start, appended after the readiness checks. */
  signInCheck?: InitCheck;
  outcome: SetupOutcome;
}

export type SetupRun = PromptRun | FlagsRun;

/** Reject after `ms` so one hung API call cannot stall the command. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Env keys whose values are secrets and must never be printed. */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSPHRASE|_PAT$|API_KEY|PRIVATE_KEY|LICENSE_KEY/;

/**
 * Values of the env keys that name a secret. Only {@link SECRET_KEY} matches
 * count: non-secret settings such as `TASK_TRACKER=jira` or `JIRA_EMAIL` would
 * otherwise mask every occurrence of their value in the report.
 */
export function secretValues(env: Env): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && SECRET_KEY.test(key)) values.add(value);
  }
  // Longest first, so a secret containing another is redacted whole.
  return [...values].sort((a, b) => b.length - a.length);
}

/** Per-probe timeout; keeps the whole command bounded when a service hangs. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
