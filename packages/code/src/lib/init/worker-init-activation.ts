/**
 * Activation steps of `devintern worker init`, after the workspace is saved:
 * license and sign-in, relay pairing, the GitHub App, and the background
 * service (systemd on Linux, launchd on macOS). The wizard asks and acts;
 * `--non-interactive` starts a `--sign-in` only when it is the missing step
 * and reports the rest as next steps (it never installs the service).
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import {
  createDefaultSupabaseAuthConfig,
  getAuthenticatedUser,
  isLoginSkipped,
  login,
  requireAuthenticatedUser,
  resolveLogin,
  startPendingLogin,
} from "@devintern/auth";
import type { ResolvedLogin, StartedPendingLogin } from "@devintern/auth";

import { pendingSignInSummary } from "../account/cli";
import { WORKER_PILOT_OFFER, signInCommand, workerLoginCommandFor } from "../account/worker-pilot";
import { isPromptAbort } from "../cli/prompt-abort";
import { hasGitHubAppCredentials, loadGitHubAppRecord } from "../code-host/github/app-setup";
import { PRManager } from "../code-host/index";
import type { WorkerEntitlementLike } from "../observability/worker-readiness";
import { connectRelayTarget, hasGitHubRelayRegistration, loadRelayState } from "../relay/connect";
import { loadWorkspaceConfig } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import { DEFAULT_MEMORY_BUDGET } from "../worker/memory-budget";
import type { MemoryBudgetPercentages } from "../worker/memory-budget";
import { gitHubSlugFromRemote } from "../workspace/env";
import {
  checkServiceManager,
  detectWorkerService,
  LAUNCHD_PLIST_NAME,
  manualServiceInstructions,
  renderLaunchdPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT_NAME,
} from "../worker/service";
import type { ServiceState, WorkerServiceDeps } from "../worker/service";
import { installAndStartWorkerService } from "../worker/service-control";
import { renderStartCheck } from "../worker/service-report";
import { workspaceCodeStateDir, workspaceConfigPath } from "../workspace/paths";
import { workspaceGitLabRelayProjects } from "./worker-connect";
import { errorMessage } from "./worker-init-fs";
import type { Env, NonInteractiveInitDeps } from "./worker-init-noninteractive-types";
import { askYesNo } from "./worker-init-policy";
import type { LogFn } from "./worker-init-policy";
import { DEFAULT_PROBE_TIMEOUT_MS, withTimeout } from "./worker-init-run";
import type {
  FlagsRun,
  GitHubAppOutcome,
  InitUserLike,
  PromptRun,
  ServiceStepResult,
  SetupRun,
} from "./worker-init-run";

type RelayConnectDeps = Parameters<typeof connectRelayTarget>[1];

/**
 * License and sign-in, reported but never aborting setup. The wizard checks
 * the license and offers a sign-in; flags mode checks the entitlement (the
 * readiness step reports the verdict) and starts a `--sign-in` when signing
 * in is what is missing.
 */
export async function licenseStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") {
    await flagsLicenseStep(run);
    return true;
  }
  const { workspaceDir } = run;
  if (!run.deps.checkAutomationLicense) return true;
  run.log("\n5️⃣  Worker Pilot or license (the worker runs unattended)...");
  try {
    let failure = await run.deps.checkAutomationLicense(workspaceDir);
    if (failure === null) {
      run.log("✅ Automation license OK.");
    } else {
      const signedIn = await currentUser(run, workspaceDir);
      if (signedIn || process.env.LICENSE_KEY) {
        // Signed in (Pilot used or not granted) or a key that did not
        // validate: the license check's own words explain it best.
        run.log(`⚠️  ${failure}`);
      } else {
        run.log(`   The worker needs the ${WORKER_PILOT_OFFER} (or a paid license).`);
      }
      const offer = signedIn
        ? false
        : await askYesNo(run, "Sign in now to start the Worker Pilot? [Y/n]: ", true);
      if (offer) {
        const user = await signInOnce(run, workspaceDir);
        if (user) failure = await run.deps.checkAutomationLicense(workspaceDir);
      } else if (!signedIn) {
        run.signInDeclined = true;
      }
      if (failure === null) {
        run.log(
          `✅ Free Worker Pilot available: your ${WORKER_PILOT_OFFER} starts when the worker first starts.`,
        );
      } else {
        run.log("   The worker will not start until this is done:");
        run.log(
          `   run \`${workerSignInCommand(workspaceDir)}\` to begin your ${WORKER_PILOT_OFFER},`,
        );
        run.log(
          "   or, with a paid license, set LICENSE_KEY in the workspace .env (https://devintern.com/pricing).",
        );
      }
    }
    run.outcome.licenseFailure = failure;
  } catch (error) {
    // Ctrl+D at the sign-in prompt stops setup; worker/cli.ts reports it.
    if (isPromptAbort(error)) throw error;
    run.log(
      `⚠️  License check errored (${(error as Error).message}); the worker re-checks at startup.`,
    );
  }
  return true;
}

/**
 * Relay pairing (optional): polling stays the correctness layer; relay only
 * improves event latency. The wizard offers it; flags mode only notes whether
 * the workspace is paired (an unpaired one gets a `connect` next step).
 */
export async function relayStep(run: SetupRun): Promise<boolean> {
  const { outcome, workspaceDir } = run;
  if (run.input === "flags") {
    try {
      outcome.relayConnected = hasGitHubRelayRegistration(loadRelayState(workspaceDir));
    } catch {
      outcome.relayConnected = false;
    }
    return true;
  }
  outcome.relayConnected = hasGitHubRelayRegistration(loadRelayState(workspaceDir));
  run.log("\n6️⃣  Instant events (optional; polling always stays on)");
  if (
    !(await askYesNo(
      run,
      "React in seconds through the DevIntern relay, without opening a port? [Y/n]: ",
      true,
    ))
  ) {
    run.log("   Relay skipped. Polling will still pick up ready tasks and review feedback.");
    return true;
  }

  const user = await resolveRelayUser(run, workspaceDir);
  if (!user) {
    run.log(
      `   Relay needs sign-in; skipped. Later: \`${workerSignInCommand(workspaceDir)}\`, ` +
        "then `devintern worker connect`.",
    );
    return true;
  }

  const connectRelay =
    run.deps.connectRelay ??
    ((options) => defaultConnectRelay(options, run.deps.runRelayConnect ?? connectRelayTarget));
  try {
    const connected = await connectRelay({
      projectRoot: run.projectRoot,
      workspaceDir,
      trackerType: run.trackerType,
      log: run.log,
    });
    outcome.relayConnected = connected || hasGitHubRelayRegistration(loadRelayState(workspaceDir));
    outcome.relayConnect = connected ? "succeeded" : "partial";
    if (connected) {
      run.log(`✅ Relay pairing stored under ${workspaceDir}.`);
    } else {
      run.log(
        "⚠️  Some relay sources did not connect. Polling still works; retry with worker connect.",
      );
    }
  } catch (error) {
    outcome.relayConnect = "failed";
    run.log(`⚠️  Relay setup failed: ${(error as Error).message}`);
    run.log("   Polling still works; relay only improves event latency.");
  }
  return true;
}

/**
 * GitHub App (@mentions). Relay-backed workspaces use the central App and keep
 * GitHub API access local through GITHUB_TOKEN; a customer-owned App is the
 * advanced no-relay path for air-gapped/direct installations only. Flags mode
 * leaves it to `worker connect`.
 */
export async function githubAppStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") return true;
  let githubRepo: string | null = null;
  try {
    githubRepo = await (run.deps.detectGithubRepo ?? detectGitHubRepo)();
  } catch {
    githubRepo = null;
  }
  if (!githubRepo) {
    run.log("\n7️⃣  GitHub App (@mentions)");
    run.log("   No GitHub remote detected; skipping the GitHub App step.");
    run.outcome.githubApp = "unavailable";
  } else {
    run.outcome.githubApp = run.outcome.relayConnected
      ? relayGitHubApp(run, run.workspaceDir, githubRepo)
      : noRelayGitHubApp(run, githubRepo);
  }
  return true;
}

/**
 * Resolve the auth-session path `worker init` reads and writes.
 *
 * Once the workspace is known the session must live in the workspace config
 * dir — the same store used by the daemon and task subprocesses. Otherwise signing in
 * during `worker init` would write the session beside the imported checkout,
 * where the unattended worker never looks, and its license check would fail.
 *
 * @param projectRoot - Imported repository root, used only before the workspace exists
 * @param workspaceDir - Workspace home once it has been written
 */
export function workerAuthSessionPath(projectRoot: string, workspaceDir?: string): string {
  const configDir = workspaceDir
    ? workspaceCodeStateDir(workspaceDir)
    : join(projectRoot, ".devintern-code");
  return join(configDir, ".auth-session.json");
}

/** Reuse an existing project sign-in when setting up its first worker. */
export function copyProjectSessionToWorkspace(projectRoot: string, workspaceDir: string): boolean {
  const source = join(projectRoot, ".devintern-code", ".auth-session.json");
  const target = workerAuthSessionPath(projectRoot, workspaceDir);
  if (!existsSync(source) || existsSync(target)) return false;
  mkdirSync(workspaceCodeStateDir(workspaceDir), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return true;
}

function projectAuthConfig(projectRoot: string, workspaceDir?: string) {
  return createDefaultSupabaseAuthConfig(workerAuthSessionPath(projectRoot, workspaceDir));
}

async function defaultGetUser(
  projectRoot: string,
  workspaceDir?: string,
): Promise<InitUserLike | null> {
  return getAuthenticatedUser(projectAuthConfig(projectRoot, workspaceDir));
}

async function defaultSignIn(
  projectRoot: string,
  workspaceDir?: string,
): Promise<InitUserLike | null> {
  const resolved = await resolveLogin(process.argv);
  return login(projectAuthConfig(projectRoot, workspaceDir), resolved, {
    skipCommand: workerSignInCommand(workspaceDir),
  });
}

/** `devintern worker login github`, with `--workspace` for a non-default workspace. */
function workerSignInCommand(workspaceDir?: string): string {
  return signInCommand(
    workspaceDir ? workerLoginCommandFor(workspaceConfigPath(workspaceDir)) : undefined,
  );
}

/**
 * Run the sign-in flow once. Ctrl+C stops setup (rethrown); a skipped or
 * failed sign-in is reported and returns null.
 */
async function signInOnce(ctx: PromptRun, workspaceDir: string): Promise<InitUserLike | null> {
  const signIn = ctx.deps.signIn ?? defaultSignIn;
  try {
    const user = await ctx.guard(signIn(ctx.projectRoot, workspaceDir));
    if (user) ctx.log(`✅ Signed in as ${user.email || user.id}.`);
    else ctx.signInDeclined = true;
    return user;
  } catch (error) {
    if (isPromptAbort(error)) throw error;
    ctx.signInDeclined = true;
    if (isLoginSkipped(error)) {
      ctx.log(`⏭️  Sign-in skipped. Sign in later with \`${workerSignInCommand(workspaceDir)}\`.`);
    } else {
      ctx.log(`⚠️  Sign-in failed: ${(error as Error).message}`);
    }
    return null;
  }
}

async function detectGitHubRepo(): Promise<string | null> {
  try {
    const detected = await new PRManager().detectRepository();
    return detected.platform === "github" ? detected.repository : null;
  } catch {
    return null;
  }
}

/** GitHub slugs already represented by a workspace, deduped in config order. */
export function workspaceGitHubRepos(config: WorkspaceConfig): string[] {
  return [
    ...new Set(
      config.repos
        .map((repo) => repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))
        .filter((repo): repo is string => Boolean(repo)),
    ),
  ];
}

async function defaultConnectRelay(
  options: {
    projectRoot: string;
    workspaceDir: string;
    trackerType: string;
    log: LogFn;
  },
  runConnect: typeof connectRelayTarget = connectRelayTarget,
): Promise<boolean> {
  const getAccessToken = async () => {
    const user = await requireAuthenticatedUser(
      projectAuthConfig(options.projectRoot, options.workspaceDir),
      "devintern worker login",
    );
    return user.accessToken;
  };
  const deps = { workingDir: options.workspaceDir, getAccessToken };
  const workspace = loadWorkspaceConfig(workspaceConfigPath(options.workspaceDir));
  // Every target is tried; one failure does not skip the rest.
  const results: boolean[] = [];
  const connect = async (target: string, extra: Omit<RelayConnectDeps, keyof typeof deps> = {}) => {
    results.push((await runConnect(target, { ...deps, ...extra })) === 0);
  };

  const repos = workspaceGitHubRepos(workspace);
  for (const repo of repos) await connect("github", { repo });
  if (repos.length === 0) {
    options.log("   No GitHub remote detected; skipping GitHub relay registration.");
  }
  const gitlabProjects = workspaceGitLabRelayProjects(workspace, options.workspaceDir);
  for (const { env, instanceUrl, projectPath } of gitlabProjects) {
    await connect("gitlab", { env, gitlabProject: { instanceUrl, projectPath } });
  }
  if (gitlabProjects.length === 0) {
    options.log("   No GitLab remote detected; skipping GitLab relay registration.");
  }
  if (options.trackerType !== "github" && options.trackerType !== "markdown") {
    await connect(options.trackerType);
  }
  return results.every(Boolean);
}

/**
 * Resolve the signed-in user for relay onboarding, offering interactive login
 * when no session exists.
 *
 * @returns The user, or null when the user declines or login fails.
 */
async function resolveRelayUser(
  ctx: PromptRun,
  workspaceDir: string,
): Promise<InitUserLike | null> {
  const user = await currentUser(ctx, workspaceDir);
  if (user) {
    ctx.log(`   Signed in as ${user.email || user.id}.`);
    return user;
  }
  // The user just said no to signing in; asking again for the relay would
  // only repeat the question.
  if (ctx.signInDeclined) return null;

  if (!(await askYesNo(ctx, "Sign in now to connect the relay? [Y/n]: ", true))) {
    return null;
  }
  return signInOnce(ctx, workspaceDir);
}

/** The signed-in user for the workspace, or null (lookup errors count as signed out). */
async function currentUser(ctx: PromptRun, workspaceDir: string): Promise<InitUserLike | null> {
  const getUser = ctx.deps.getUser ?? defaultGetUser;
  try {
    return await getUser(ctx.projectRoot, workspaceDir);
  } catch {
    return null;
  }
}

/** No-relay path: only a customer-owned App can deliver @mentions. */
function noRelayGitHubApp(ctx: PromptRun, githubRepo: string): GitHubAppOutcome {
  ctx.log(`\n7️⃣  GitHub App on ${githubRepo} (advanced no-relay mode)`);
  if (hasGitHubAppCredentials()) {
    ctx.log("✅ Customer-owned GitHub App credentials found in the environment.");
    ctx.log("   The worker will use that App for polling, @mentions, and GitHub API calls.");
    return "existing";
  }
  ctx.log("   Relay is not connected, so the hosted DevIntern App cannot deliver events here.");
  ctx.log("   GITHUB_TOKEN still supports task PRs and review polling on the worker's own PRs.");
  ctx.log("   For air-gapped @mentions or direct webhooks, configure a customer-owned GitHub App");
  ctx.log("   with GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY_PATH/BASE64.");
  return "skipped";
}

/** Relay path: verify the central DevIntern App installation for this repo. */
function relayGitHubApp(
  ctx: PromptRun,
  workspaceDir: string,
  githubRepo: string,
): GitHubAppOutcome {
  ctx.log(`\n7️⃣  DevIntern AI GitHub App on ${githubRepo} (@mentions)`);
  ctx.log("   The central App delivers events through the relay; your GITHUB_TOKEN remains local");
  ctx.log("   and handles GitHub API reads/writes. No App ID or private key is needed here.");
  ctx.log("   @devintern-ai mentions on any PR then react through the relay in seconds.");
  const existing = loadGitHubAppRecord(workspaceDir, githubRepo);
  if (
    existing?.enabled &&
    existing.repo === githubRepo.toLowerCase() &&
    typeof existing.installationId === "number" &&
    typeof existing.repositoryId === "number"
  ) {
    ctx.log(
      `✅ GitHub App already verified for ${existing.repo} (${existing.connectedAt ?? "unknown date"}).`,
    );
    return "existing";
  }
  ctx.log("   No verified GitHub App pairing was recorded.");
  ctx.log("   Run: devintern worker connect github");
  ctx.log("   The relay verifies the installation before it enables event routing.");
  return "skipped";
}

/** Flags mode: the checks start with the entitlement, because `--sign-in` depends on it. */
async function flagsLicenseStep(run: FlagsRun): Promise<void> {
  const { deps, workspaceDir } = run;
  run.log("🩺 Running checks...");
  const check = deps.doctor?.checkEntitlement;
  // `worker doctor` loads the workspace .env into process.env first; this
  // command does not, so pass the composed env (workspace .env < env <
  // --env-file): LICENSE_KEY and DEVINTERN_SKIP_LICENSE_CHECK then give the
  // same verdict as `worker doctor`.
  run.entitlement = withTimeout(
    Promise.resolve().then(() =>
      check
        ? check(workspaceDir)
        : checkWorkerEntitlement(workspaceDir, run.plan?.credentialEnv ?? {}, deps.checkLicense),
    ),
    deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    "license check",
  );
  // An error becomes the readiness step's failed entitlement row.
  const entitlement = await run.entitlement.catch(() => undefined);
  if (!run.args.signIn) return;
  if (entitlement?.valid === true || entitlement?.signInRequired !== true) {
    run.log(
      entitlement?.valid === true
        ? "ℹ️  --sign-in: not needed, this workspace already has an entitlement."
        : "ℹ️  --sign-in: not started; signing in would not fix the entitlement check above.",
    );
    return;
  }
  const loginCommand = workerLoginCommandFor(workspaceConfigPath(workspaceDir), deps.home);
  try {
    const started = await (deps.startSignIn ?? defaultStartSignIn)(workspaceDir, run.args.signIn);
    run.report.signIn = pendingSignInSummary(started, loginCommand);
  } catch (error) {
    run.signInCheck = {
      name: "sign-in",
      label: "Sign-in",
      status: "fail",
      message: `Could not start the sign-in: ${errorMessage(error)}`,
      hint: `Retry with \`${signInCommand(loginCommand)} --no-wait --json\``,
    };
  }
}

/**
 * The worker's automation entitlement, as `worker doctor` checks it. Worded
 * for setup, and naming the workspace sign-in command (the worker reads the
 * workspace session).
 */
export async function checkWorkerEntitlement(
  workspaceDir: string,
  env: Env = process.env,
  checkLicenseOverride?: NonInteractiveInitDeps["checkLicense"],
): Promise<WorkerEntitlementLike> {
  const [{ checkLicense }, { loadSupabaseConfig }] = await Promise.all([
    import("@devintern/license-check"),
    import("../cli/bootstrap"),
  ]);
  return (checkLicenseOverride ?? checkLicense)({
    productKey: "devintern/code",
    licenseKey: env.LICENSE_KEY || undefined,
    supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)),
    requireAutomation: true,
    allowTrial: true,
    setup: true,
    loginCommand: "devintern worker login",
    env,
  });
}

/** Start a `--no-wait` sign-in for the workspace session. */
async function defaultStartSignIn(
  workspaceDir: string,
  resolved: ResolvedLogin,
): Promise<StartedPendingLogin> {
  const { loadSupabaseConfig } = await import("../cli/bootstrap");
  return startPendingLogin(loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)), resolved);
}

/** Where and how the service would run. */
interface ServiceRuntime {
  platform: "linux" | "darwin";
  workspaceDir: string;
  paths: { execPath: string; runtimePath: string; environmentPath: string };
  /** Host-memory percentages for the generated systemd unit. */
  memory: MemoryBudgetPercentages;
  deps: WorkerServiceDeps;
}

/** The workspace's memory budget, or the defaults when its config cannot be read. */
function serviceMemoryBudget(workspaceDir: string): MemoryBudgetPercentages {
  try {
    return loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).workspace.execution.memory;
  } catch {
    return DEFAULT_MEMORY_BUDGET;
  }
}

/**
 * Background service (optional). The wizard offers to install and launch it;
 * the foreground command stays an honest supported path on every platform,
 * and a declined offer (or a failed automatic install) keeps the manual
 * write-definition-and-print-instructions path. With readiness blockers it is
 * not offered: it would only start a failing worker. Flags mode reports it as
 * a next step.
 */
export async function serviceStep(run: SetupRun): Promise<boolean> {
  if (run.input === "prompt") run.outcome.service = await offerService(run);
  return true;
}

async function offerService(ctx: PromptRun): Promise<ServiceStepResult> {
  ctx.log("\n8️⃣  Background service (optional)");
  const { deps, workspaceDir } = ctx;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    ctx.log(`   No generated service definition for ${platform}; run the worker in a terminal.`);
    return { serviceRunning: false, serviceInstall: "unavailable" };
  }
  if (deps.noService) {
    ctx.log("   Skipped (--no-service); `devintern worker` runs the same daemon in a terminal.");
    return { serviceRunning: false, serviceInstall: "skipped" };
  }
  const runtime: ServiceRuntime = {
    platform,
    workspaceDir,
    paths: {
      execPath: deps.execPath ?? (process.argv[1] ? resolve(process.argv[1]) : "devintern"),
      runtimePath: deps.runtimePath ?? process.execPath,
      environmentPath: deps.environmentPath ?? process.env.PATH ?? "",
    },
    memory: serviceMemoryBudget(workspaceDir),
    deps: { platform, homedir: deps.homedir, uid: deps.uid, run: deps.run },
  };
  // The host step already asked the service manager; do not ask (or say it) twice.
  const checked = ctx.host?.checks.serviceManager;
  const manager =
    checked ?? (await (deps.checkServiceManager ?? (() => checkServiceManager(runtime.deps)))());
  if (!manager.available) {
    if (!checked) ctx.log(`   A background service is not available here: ${manager.reason}.`);
    ctx.log("   Run the worker in the foreground instead: `devintern worker`");
    ctx.log("   (inside tmux or screen to keep it running after you disconnect).");
    return { serviceRunning: false, serviceInstall: "unavailable" };
  }

  const state = deps.detectService
    ? await deps.detectService()
    : await detectWorkerService(runtime.deps);
  if (state.installed && !state.managed) {
    // Leave custom definitions and their running processes untouched.
    ctx.log("⚠️  The installed service has custom settings and will not be overwritten.");
    printManualServiceDefinition(ctx, runtime);
    return { serviceRunning: state.active, serviceInstall: "existing" };
  }
  if (ctx.outcome.blockers.length > 0) {
    // Installing now would start a worker that exits (or crash-loops) at
    // once; the closing summary lists what to do first.
    ctx.log("   Not installed yet: the worker would not start until the steps below are done.");
    ctx.log("   Then install it with: devintern worker service install");
    return {
      serviceRunning: false,
      serviceInstalled: state.installed,
      serviceInstall: "not_ready",
    };
  }
  if (!(await confirmServiceInstall(ctx, state, platform))) {
    printManualServiceDefinition(ctx, runtime);
    return { serviceRunning: false, serviceInstall: "declined" };
  }
  return installService(ctx, runtime);
}

/** Ask whether to install/update the native user service. */
async function confirmServiceInstall(
  ctx: PromptRun,
  state: ServiceState,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (state.installed) {
    const offer = state.active ? "restart and update" : "update";
    const bootSuffix = platform === "linux" ? " and ensure it starts at boot" : "";
    return askYesNo(
      ctx,
      `A devintern-worker service is already installed. ${offer} it${bootSuffix} now? [Y/n]: `,
      true,
    );
  }
  const action =
    platform === "linux"
      ? "Install and start the background service at boot now? [Y/n]: "
      : "Install and start the background service now? [Y/n]: ";
  return askYesNo(ctx, action, true);
}

/** Write the platform service definition and print the manual install steps. */
function printManualServiceDefinition(ctx: PromptRun, runtime: ServiceRuntime): void {
  const { platform, workspaceDir, paths, memory } = runtime;
  const [name, content] =
    platform === "linux"
      ? [SYSTEMD_UNIT_NAME, renderSystemdUnit({ ...paths, projectDir: workspaceDir, memory })]
      : [LAUNCHD_PLIST_NAME, renderLaunchdPlist({ ...paths, workingDir: workspaceDir })];
  const definitionPath = join(workspaceDir, name);
  (ctx.deps.writeFile ?? ((path, text) => writeFileSync(path, text, "utf8")))(
    definitionPath,
    content,
  );
  ctx.log(`💾 Wrote ${definitionPath}`);
  ctx.log("   Install it yourself with:");
  for (const line of manualServiceInstructions({ platform, workspaceDir })) {
    ctx.log(`     ${line}`);
  }
}

/** Run the install/restart action and report its outcome. */
async function installService(ctx: PromptRun, runtime: ServiceRuntime): Promise<ServiceStepResult> {
  const { platform, workspaceDir, paths, memory } = runtime;
  const since = Date.now();
  const verify = ctx.deps.verifyServiceStart;
  const { install: result, start } = ctx.deps.installService
    ? {
        install: await ctx.deps.installService({ workspaceDir, ...paths, log: ctx.log }),
        start: undefined,
      }
    : await installAndStartWorkerService(
        {
          workspaceDir,
          ...paths,
          memory,
          waitForStart: verify ? (from) => verify({ workspaceDir, since: from }) : undefined,
        },
        runtime.deps,
      );

  if (!result.ok) {
    ctx.log(`❌ Could not install the service automatically: ${result.error}`);
    ctx.log("   Nothing was left half-installed. Install it manually:");
    printManualServiceDefinition(ctx, runtime);
    return { serviceRunning: false, serviceInstall: "failed" };
  }

  ctx.log(
    result.updated
      ? "✅ devintern-worker service updated and restarted; waiting for the worker..."
      : "✅ devintern-worker service installed; waiting for the worker to start...",
  );
  const check =
    start ?? (verify ? await verify({ workspaceDir, since }) : { state: "running" as const });
  for (const line of renderStartCheck(check, { platform, workspaceDir })) {
    ctx.log(line);
  }
  if (result.warning) {
    ctx.log(`⚠️  ${result.warning}`);
  } else if (platform === "linux") {
    ctx.log("   User lingering is on, so the service starts at boot and survives logout.");
  }
  ctx.log("   Manage it with `devintern worker service status|restart|stop|logs`.");
  return {
    serviceRunning: check.state === "running",
    serviceInstalled: true,
    serviceInstall: result.updated ? "updated" : "installed",
  };
}
