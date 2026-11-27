/**
 * What follows a `devintern worker login`: pair the relay (the same as
 * `worker connect --no-wait --json`, unless `--no-relay`) and, when
 * `worker init --non-interactive --start` deferred it until the sign-in,
 * install and start the background service (the same as
 * `worker service install --json`). The results are added to the login
 * `--json` document as `relay`, `service`, and `nextSteps`.
 */

import type { NextStep } from "../observability/readiness-json";
import { loadWorkspaceConfig } from "../workspace/config";
import type { ServiceCommandReport } from "../worker/service-command";
import { clearWorkerStartIntent, loadWorkerStartIntent } from "../worker/start-intent";
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
  const intent = options.signedIn ? loadWorkerStartIntent(options.workspaceDir) : null;
  const noRelay = options.noRelay || intent?.relay === false;
  const relay: SignInRelayReport = noRelay
    ? { result: "skipped", code: "no_relay", message: "Relay pairing skipped (--no-relay)." }
    : await pairRelay(options, deps, log);
  if (relay.result === "skipped") log(`ℹ️  ${relay.message}`);

  const followUp: WorkerSignInFollowUp = { relay };
  if (intent) followUp.service = await startService(options, deps, log);
  const relaySteps = relay.result === "skipped" ? [] : (relay.nextSteps ?? []);
  const nextSteps = [...relaySteps, ...(followUp.service?.nextSteps ?? [])];
  if (nextSteps.length > 0) followUp.nextSteps = nextSteps;
  return followUp;
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
  if (pending) log(pending);
  try {
    return JSON.parse(stdout) as ConnectJsonDocument;
  } catch (error) {
    return {
      schema: "devintern.worker-connect",
      version: 1,
      target: "all",
      result: "failure",
      code: "connect_failed",
      error: `Relay pairing did not report a result: ${errorMessage(error)}`,
    };
  }
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
    report = {
      schema: "devintern.worker-service",
      version: 1,
      action: "install",
      result: "error",
      code: "service_command_failed",
      error: errorMessage(error),
      workspaceDir,
      warnings: [],
      nextSteps: [],
    };
  }
  if (!options.json) {
    for (const line of renderServiceReport(report, deps.platform ?? process.platform)) log(line);
  }
  return report;
}
