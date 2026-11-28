/**
 * What follows a `devintern worker login`: pair the relay (the same as
 * `worker connect --no-wait --json`, unless `--no-relay`) and, when
 * `worker init --non-interactive --start` deferred it until the sign-in,
 * install and start the background service (the same as
 * `worker service install --json`). The results are added to the login
 * `--json` document as `relay`, `service`, and `nextSteps`.
 *
 * A relay-only `--no-relay` intent applies only to the sign-in setup reported
 * it: one recorded before the pending sign-in being completed is forgotten.
 */

import type { NextStep } from "../observability/readiness-json";
import { serviceInstallCommand } from "../observability/readiness-json";
import { loadWorkspaceConfig } from "../workspace/config";
import type { ServiceCommandReport } from "../worker/service-command";
import { clearWorkerStartIntent, loadWorkerStartIntent } from "../worker/start-intent";
import type { WorkerStartIntent } from "../worker/start-intent";
import {
  runWorkerConnectCommand,
  workspaceGitLabRelayProjects,
  workspaceRelayRepos,
} from "./worker-connect";
import type { ConnectJsonDocument } from "./worker-connect-json";
import { errorMessage } from "./worker-init-fs";

/** Relay pairing left out: `--no-relay`, or no GitHub/GitLab repository to pair. */
export interface RelaySkipped {
  result: "skipped";
  code: "no_relay" | "no_relay_sources";
  message: string;
}

/** `relay` in the login document: the `worker connect --json` document, or why it did not run. */
export type SignInRelayReport = ConnectJsonDocument | RelaySkipped;

/** Fields added to the login `--json` document. */
export interface WorkerSignInFollowUp {
  relay: SignInRelayReport;
  /** Set when a `worker init --start` was waiting for this sign-in. */
  service?: ServiceCommandReport;
  /** Steps left after the sign-in (approve the GitHub App, check the service). */
  nextSteps?: NextStep[];
}

export interface WorkerSignInFollowUpOptions {
  workspaceDir: string;
  configPath: string;
  json: boolean;
  noRelay: boolean;
  /** This login completed a sign-in (only then does a deferred service start run). */
  signedIn: boolean;
  /** When the pending sign-in this login completed began (ISO 8601), if known. */
  pendingSignInStartedAt?: string;
  /** Human progress lines (stderr while `--json` owns stdout). */
  log?: (line: string) => void;
}

export interface WorkerSignInFollowUpDeps {
  connect?: typeof runWorkerConnectCommand;
  installService?: (workspaceDir: string) => Promise<ServiceCommandReport>;
  platform?: NodeJS.Platform;
}

/** Pair the relay and run a deferred service start after a worker sign-in. */
export async function runWorkerSignInFollowUp(
  options: WorkerSignInFollowUpOptions,
  deps: WorkerSignInFollowUpDeps = {},
): Promise<WorkerSignInFollowUp> {
  const log = options.log ?? ((line: string) => console.log(line));
  const recorded = options.signedIn ? loadWorkerStartIntent(options.workspaceDir) : null;
  // A relay-only intent belongs to the sign-in setup reported. One recorded
  // before the sign-in being completed belongs to an earlier run: forget it
  // rather than make this deliberate login skip pairing.
  const stale = predatesSignIn(recorded, options.pendingSignInStartedAt);
  const intent = stale ? null : recorded;
  if (stale) clearWorkerStartIntent(options.workspaceDir);
  const noRelay = options.noRelay || intent?.relay === false;
  const relay: SignInRelayReport = noRelay
    ? { result: "skipped", code: "no_relay", message: "Relay pairing skipped (--no-relay)." }
    : await pairRelay(options, deps, log);
  if (relay.result === "skipped") log(`ℹ️  ${relay.message}`);

  const followUp: WorkerSignInFollowUp = { relay };
  if (intent?.start) {
    // A completed sign-in always spends the request: one attempt per sign-in,
    // even when the install cannot run or fails.
    try {
      followUp.service = await startService(options, deps, log);
    } catch (error) {
      followUp.service = serviceFailureReport(options.workspaceDir, error);
    } finally {
      clearWorkerStartIntent(options.workspaceDir);
    }
  } else if (intent) {
    // A relay-only intent (`--no-relay` without `--start`) applies once.
    clearWorkerStartIntent(options.workspaceDir);
  }
  const relaySteps = relay.result === "skipped" ? [] : (relay.nextSteps ?? []);
  const nextSteps = [...relaySteps, ...(followUp.service?.nextSteps ?? [])];
  if (nextSteps.length > 0) followUp.nextSteps = nextSteps;
  return followUp;
}

/**
 * True when a relay-only intent (a `--no-relay` choice recorded without
 * `--start`) predates the pending sign-in being completed. Such an intent
 * describes an earlier setup, not this sign-in, so it must not apply.
 */
function predatesSignIn(
  intent: WorkerStartIntent | null,
  pendingSignInStartedAt: string | undefined,
): boolean {
  if (!intent || intent.start !== false || pendingSignInStartedAt === undefined) return false;
  const startedAt = Date.parse(pendingSignInStartedAt);
  return Number.isFinite(startedAt) && Date.parse(intent.requestedAt) < startedAt;
}

/** `worker connect --no-wait --json` for the workspace; its text goes to `log`. */
async function pairRelay(
  options: WorkerSignInFollowUpOptions,
  deps: WorkerSignInFollowUpDeps,
  log: (line: string) => void,
): Promise<SignInRelayReport> {
  try {
    const config = loadWorkspaceConfig(options.configPath);
    if (
      workspaceRelayRepos(config).length === 0 &&
      workspaceGitLabRelayProjects(config, options.workspaceDir).length === 0
    ) {
      return {
        result: "skipped",
        code: "no_relay_sources",
        message: "No GitHub or GitLab repository to pair with the relay yet; polling still works.",
      };
    }
  } catch {
    // An unreadable workspace.toml: the connect command reports it.
  }
  log("🔌 Pairing the DevIntern relay for instant events...");
  let stdout = "";
  let pending = "";
  try {
    await (deps.connect ?? runWorkerConnectCommand)(["--no-wait", "--json"], {
      workspaceDir: options.workspaceDir,
      workspacePath: options.configPath,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) log(line);
      },
    });
  } catch (error) {
    // Pairing failed, but the caller still owns the rest of the follow-up (a
    // deferred service start): report the failure instead of aborting it.
    if (pending) log(pending);
    return connectFailure(`Relay pairing did not run: ${errorMessage(error)}`);
  }
  if (pending) log(pending);
  try {
    return JSON.parse(stdout) as ConnectJsonDocument;
  } catch (error) {
    return connectFailure(`Relay pairing did not report a result: ${errorMessage(error)}`);
  }
}

/** A relay-pairing failure in the login document, with the command that retries it. */
function connectFailure(error: string): ConnectJsonDocument {
  return {
    schema: "devintern.worker-connect",
    version: 1,
    target: "all",
    result: "failure",
    code: "connect_failed",
    error,
    nextSteps: [
      {
        id: "pair-relay",
        message: "Pair the relay for instant events now that the sign-in is complete",
        command: "devintern worker connect",
      },
    ],
  };
}

/** Install and start the service that `worker init --start` deferred, then forget the request. */
async function startService(
  options: WorkerSignInFollowUpOptions,
  deps: WorkerSignInFollowUpDeps,
  log: (line: string) => void,
): Promise<ServiceCommandReport> {
  const { workspaceDir } = options;
  // Forget it first: one attempt per request, even if the install fails.
  clearWorkerStartIntent(workspaceDir);
  log("🚀 Installing and starting the worker service (requested by `worker init --start`)...");
  const { renderServiceReport, runServiceAction, collectServiceReadiness } =
    await import("../worker/service-command");
  const { DEFAULT_START_TIMEOUT_MS } = await import("../worker/service-control");
  let report: ServiceCommandReport;
  try {
    report = deps.installService
      ? await deps.installService(workspaceDir)
      : await runServiceAction(
          {
            action: "install",
            json: true,
            force: false,
            waitMs: DEFAULT_START_TIMEOUT_MS,
            lines: 100,
          },
          { workspaceDir, collectReadiness: collectServiceReadiness },
        );
  } catch (error) {
    report = serviceFailureReport(workspaceDir, error);
  }
  if (!options.json) {
    for (const line of renderServiceReport(report, deps.platform ?? process.platform)) log(line);
  }
  return report;
}

/** The service command could not run: report it with the command that retries it. */
function serviceFailureReport(workspaceDir: string, error: unknown): ServiceCommandReport {
  return {
    schema: "devintern.worker-service",
    version: 1,
    action: "install",
    result: "error",
    code: "service_command_failed",
    error: errorMessage(error),
    workspaceDir,
    warnings: [],
    nextSteps: [
      {
        id: "service",
        message: "Install and start the background service",
        command: serviceInstallCommand(workspaceDir),
      },
    ],
  };
}
