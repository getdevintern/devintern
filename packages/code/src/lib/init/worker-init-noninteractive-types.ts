/**
 * Types of the `devintern worker init --non-interactive` command and its
 * `--json` document (schema `devintern.worker-init`).
 */

import type { ResolvedLogin, StartedPendingLogin } from "@devintern/auth";
import type { LicenseCheckOptions } from "@devintern/license-check";

import type { PendingSignIn } from "../account/cli";
import type { NextStep, ReadinessResult, ReportCheck } from "../observability/readiness-json";
import type { WorkerDoctorDeps, WorkerEntitlementLike } from "../observability/worker-readiness";
import type { GitHubCliToken, GitHubTokenSource } from "./github-cli-token";
import type { DevinternLabelOpsFactory } from "./worker-init-label";
import type { ServiceCommandReport } from "../worker/service-command";

/** `schema` value of the `--json` document. Bump `version` on breaking changes. */
export const WORKER_INIT_JSON_SCHEMA = "devintern.worker-init";
/** Current `--json` document version. */
export const WORKER_INIT_JSON_VERSION = 1;

export type Env = Record<string, string | undefined>;

/** Parsed `worker init --non-interactive` flags. */
export interface NonInteractiveInitArgs {
  tracker?: string;
  taskQuery?: string;
  repoFromCwd: boolean;
  envFile?: string;
  json: boolean;
  yes: boolean;
  /** `--sign-in <method>`: start a `--no-wait` sign-in when one is needed. */
  signIn?: ResolvedLogin;
  /** `--remove-env-file`: delete the `--env-file` once its values are saved. */
  removeEnvFile?: boolean;
  /** `--create-label`: create the `devintern` label when the tracker lacks it. */
  createLabel?: boolean;
  /**
   * `--start`: install and start the service when the checks pass; when only
   * signing in is left, the next `worker login` does it after signing in.
   */
  start?: boolean;
  /** `--no-relay`: leave relay pairing out (also of a `--start` sign-in). */
  noRelay?: boolean;
}

/**
 * With `--start`: `installed` (see `service` for whether the worker is
 * running), `after_sign_in` (the next `worker login` installs and starts it),
 * `not_ready` (a check failed; nothing was installed), or `failed` (the
 * install itself failed; see `service`).
 */
export type InitStartResult = "installed" | "after_sign_in" | "not_ready" | "failed";

/**
 * `action_required`: every check passed or warned except a step for the user
 * (signing in to start the Worker Pilot). Exit code 2. `unchanged`: the
 * workspace already had exactly this setup and every check passed (exit 0).
 */
export type InitResult = ReadinessResult | "unchanged";

/** One check in the report. */
export type InitCheck = ReportCheck;

/** One remaining step the user (or agent) still has to do (the shared next-step shape). */
export type InitNextStep = NextStep;

/** Stable `code` of a failed init that stopped before (or instead of) the checks. */
export type InitErrorCode =
  | "invalid_arguments"
  | "unsupported_tracker"
  | "env_file_unreadable"
  | "missing_input"
  | "invalid_query"
  | "not_a_repository"
  | "workspace_exists"
  | "workspace_invalid"
  | "workspace_busy"
  | "write_failed"
  | "unexpected_error";

/** The report printed by the command; `--json` prints it verbatim. */
export interface NonInteractiveInitReport {
  schema: typeof WORKER_INIT_JSON_SCHEMA;
  version: typeof WORKER_INIT_JSON_VERSION;
  result: InitResult;
  /** Set when the command stopped before running checks (bad input, busy workspace). */
  error?: string;
  /**
   * Set on every failure: an {@link InitErrorCode} when the command stopped
   * early, otherwise the first failed check's code (e.g. `query_rejected`).
   */
  code?: string;
  /** With `code: "missing_input"`: the flags and variables that were not supplied. */
  missing?: string[];
  workspaceDir: string;
  tracker: string | null;
  taskQuery: string | null;
  repo: InitRepo | null;
  /** Files this run changed and kept. A failed run restores what it wrote, so this is empty. */
  filesWritten: string[];
  /** False when nothing needed to change (a re-run with the same flags). */
  changed: boolean;
  /** True when the workspace on disk holds this setup (written now or already there). */
  persisted: boolean;
  /** Things to know that are not failures (e.g. the `--env-file` still holds the credentials). */
  warnings: string[];
  /**
   * Where the `GITHUB_TOKEN` this run used came from. Absent when no token was
   * needed. A token from the process environment reports `env`; one from
   * `--env-file` or already saved in the workspace `.env` reports `env-file`.
   */
  tokenSource?: GitHubTokenSource;
  checks: InitCheck[];
  nextSteps: InitNextStep[];
  /** Set when `--sign-in` started a sign-in: open `url`, then run `complete` on this host. */
  signIn?: PendingSignIn;
  /** True when `--remove-env-file` deleted the `--env-file` after saving its values. */
  envFileRemoved?: boolean;
  /** True when `--create-label` created the `devintern` label in the tracker. */
  labelCreated?: boolean;
  /** Set with `--start`: what happened to the background service. */
  start?: { result: InitStartResult };
  /** Set when `--start` ran the install: the `worker service install --json` document. */
  service?: ServiceCommandReport;
}

/** The `[[repos]]` entry `--repo-from-cwd` registered. */
export interface InitRepo {
  name: string;
  remote: string;
  added: boolean;
  /** `default_branch` written for a new entry: the remote's default branch. */
  defaultBranch?: string;
  /** Branch the checkout was on. */
  branch?: string;
}

export interface NonInteractiveInitDeps {
  /** Working directory for `--repo-from-cwd` and relative `--env-file`. */
  cwd?: string;
  /** Process environment; defaults to `process.env`. */
  processEnv?: Env;
  /** Workspace home; defaults to `resolveWorkspaceDir()`. */
  workspaceDir?: string;
  /** Tracker credential probe; defaults to the wizard's probe. */
  probe?: (trackerId: string, env: Record<string, string>) => Promise<void>;
  /** Reads a signed-in GitHub CLI token when `GITHUB_TOKEN` is missing; defaults to `gh`. */
  githubCliToken?: () => GitHubCliToken | null;
  /** Overrides for the `worker doctor` checks (tests). */
  doctor?: WorkerDoctorDeps;
  /** License validator behind the default entitlement check; defaults to `checkLicense` (tests). */
  checkLicense?: (options: LicenseCheckOptions) => Promise<WorkerEntitlementLike>;
  /** Per-probe timeout. */
  probeTimeoutMs?: number;
  /** Progress messages (human mode only). */
  log?: (message: string) => void;
  /** Starts a `--no-wait` sign-in for the workspace (tests); defaults to `startPendingLogin`. */
  startSignIn?: (workspaceDir: string, login: ResolvedLogin) => Promise<StartedPendingLogin>;
  /** Home directory used to decide whether commands need `--workspace` (tests). */
  home?: string;
  /** Finds an executable on PATH for the install-agent step (tests). */
  which?: (command: string) => string | null;
  /** Looks up and creates the `devintern` label (tests); defaults to the tracker API. */
  devinternLabelOps?: DevinternLabelOpsFactory;
  /** `--start`: installs and starts the service (tests); defaults to `worker service install`. */
  installService?: (workspaceDir: string) => Promise<ServiceCommandReport>;
}
