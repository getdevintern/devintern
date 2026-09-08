/**
 * Interactive `devintern worker init`: guided unattended-worker setup.
 *
 * Writes a workspace (first import is N=1) instead of `WORKER_TASK_QUERY` in
 * `.env`, dry-runs the ready-tasks query, checks any automation license,
 * offers Sentry auto-fixes, relay pairing plus the central DevIntern App
 * (@mention events), and can install and launch a native user service
 * (systemd on Linux, launchd on macOS) — or just write its definition and
 * print the manual steps. Polling is always on; direct webhooks run as a
 * separate advanced service.
 *
 * Prompt-loop mechanics come from `@devintern/task-trackers` (shared with
 * `devintern init`); everything effectful is injectable for tests.
 */

import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import {
  createDefaultSupabaseAuthConfig,
  getAuthenticatedUser,
  login,
  requireAuthenticatedUser,
  resolveLogin,
} from "@devintern/auth";
import { defaultProbe, parseEnvContent } from "@devintern/task-trackers";
import { findProjectRoot } from "@devintern/utils";

import {
  GITHUB_APP_INSTALL_URL,
  hasGitHubAppCredentials,
  loadGitHubAppRecord,
} from "./github-app-setup";
import { runTrackerSetup } from "./init-wizard";
import { PRManager } from "./pr-client";
import { connectRelayTarget, hasGitHubRelayRegistration, loadRelayState } from "./relay-connect";
import { parseCronOrIntervalSchedule } from "./automation-config";
import { isValidTimeZone, parseTimeWindowSpec } from "./schedule";
import {
  TRACKER_CAPABILITIES,
  supportsPolling,
  trackersSupportingPolling,
} from "./tracker-capabilities";
import {
  ensureWorkspaceAndAddRepo,
  writeWorkerOperatingPolicy,
  writeWorkspaceDefaults,
} from "./workspace/init";
import { loadWorkspaceConfig } from "./workspace/config";
import type { WorkspaceConfig } from "./workspace/config";
import { gitHubSlugFromRemote } from "./workspace/env";
import { workspaceConfigPath } from "./workspace/paths";
import { runWorkerSentrySetup } from "./worker-sentry-setup";
import type { SentryValidationOptions } from "./worker-sentry-setup";
import {
  detectWorkerService,
  installWorkerService,
  LAUNCHD_PLIST_NAME,
  manualServiceInstructions,
  renderLaunchdPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT_NAME,
} from "./worker-service";
import type {
  RunCommandFn,
  ServiceInstallResult,
  ServiceState,
  WorkerServiceDeps,
} from "./worker-service";

export { renderLaunchdPlist, renderSystemdUnit } from "./worker-service";

export type PromptFn = (question: string) => Promise<string>;
export type LogFn = (message: string) => void;

/** Env keys the worker wizard used to own in `.devintern-code/.env`. */
export const WORKER_ENV_KEYS = [
  "WORKER_TASK_QUERY",
  "WORKER_POLL_INTERVAL",
  "WORKER_TASK_ARGS",
  "WEBHOOK_SECRET",
  "WEBHOOK_PORT",
] as const;

/**
 * Insert or update KEY=value lines in an env file's content. Existing keys
 * are updated in place (even when commented out); new keys are appended under
 * a worker section header.
 *
 * @param content - Current `.env` content
 * @param vars - Key/value pairs to write
 */
export function upsertEnvVars(content: string, vars: Record<string, string>): string {
  const lines = content.split("\n");
  const pending = new Map(Object.entries(vars));

  const updated = lines.map((line) => {
    const match = line.match(/^\s*#?\s*([A-Z0-9_]+)=/);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  if (pending.size > 0) {
    if (updated.at(-1)?.trim() !== "") {
      updated.push("");
    }
    updated.push("# Worker daemon (devintern worker) — written by 'devintern worker init'");
    for (const [key, value] of pending) {
      updated.push(`${key}=${value}`);
    }
    updated.push("");
  }

  return updated.join("\n");
}

/** Generate a webhook signing secret (hex, 32 bytes). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export interface WorkerInitResult {
  ok: boolean;
}

export interface WorkerInitDeps {
  prompt?: PromptFn;
  log?: LogFn;
  cwd?: string;
  /** Evaluate the ready-tasks query; returns the number of matching tasks. */
  dryRunQuery?: (query: string) => Promise<number>;
  /** Automation license check; returns a human-readable failure, or null when entitled. */
  checkAutomationLicense?: () => Promise<string | null>;
  /** Override tracker-config step. Return tracker id, or null to abort. */
  ensureTracker?: (ctx: { cwd: string; prompt: PromptFn; log: LogFn }) => Promise<string | null>;
  /** Override workspace write. */
  bootstrapWorkspace?: (opts: {
    cwd: string;
    log: LogFn;
  }) => Promise<{ workspaceDir: string; created?: boolean; repoName?: string } | { error: string }>;
  /** Signed-in user lookup for relay onboarding. */
  getUser?: (projectRoot: string) => Promise<InitUserLike | null>;
  /** Interactive login for relay onboarding. */
  signIn?: (projectRoot: string) => Promise<InitUserLike | null>;
  /** Register relay sources while persisting state under the workspace home. */
  connectRelay?: (ctx: {
    projectRoot: string;
    workspaceDir: string;
    trackerType: string;
    log: LogFn;
  }) => Promise<boolean>;
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
  /** Override the whole install-and-launch action (tests). */
  installService?: (ctx: {
    workspaceDir: string;
    execPath: string;
    runtimePath: string;
    environmentPath: string;
    log: LogFn;
  }) => Promise<ServiceInstallResult>;
}

interface InitUserLike {
  id: string;
  email: string | null;
}

export async function configureWorkerOperatingPolicy(ctx: {
  workspaceDir: string;
  prompt: PromptFn;
  log: LogFn;
}): Promise<void> {
  const current = loadWorkspaceConfig(workspaceConfigPath(ctx.workspaceDir));
  const yesNo = async (question: string, fallback: boolean): Promise<boolean> => {
    for (;;) {
      const answer = (await ctx.prompt(question)).trim().toLowerCase();
      if (!answer) return fallback;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      ctx.log("   Enter y or n.");
    }
  };

  const ciFailureFix = await yesNo(
    `Automatically repair failing CI on worker-created PRs? [${current.workspace.ciFailureFix ? "Y/n" : "y/N"}]: `,
    current.workspace.ciFailureFix,
  );

  let conflictResolution = current.workspace.conflictResolution;
  for (;;) {
    const answer = (
      await ctx.prompt(
        `Conflict handling [auto/scheduled/disabled] [${current.workspace.conflictResolution}]: `,
      )
    )
      .trim()
      .toLowerCase();
    if (!answer) break;
    if (answer === "auto" || answer === "scheduled" || answer === "disabled") {
      conflictResolution = answer;
      break;
    }
    ctx.log("   Choose auto, scheduled, or disabled.");
  }

  let conflictResolutionCron: string | undefined;
  let conflictResolutionInterval: string | undefined;
  if (conflictResolution === "scheduled") {
    const existingSchedule =
      current.workspace.conflictSchedule?.cron ??
      current.workspace.conflictSchedule?.interval ??
      "0 3 * * *";
    for (;;) {
      const value =
        (
          await ctx.prompt(
            `Conflict-resolution schedule (cron or interval) [${existingSchedule}]: `,
          )
        ).trim() || existingSchedule;
      const errors: string[] = [];
      const isCron = value.split(/\s+/).length > 1;
      const parsed = parseCronOrIntervalSchedule(
        isCron ? { cron: value } : { interval: value },
        { label: "Conflict schedule" },
        errors,
      );
      if (parsed) {
        conflictResolutionCron = parsed.cron;
        conflictResolutionInterval = parsed.interval;
        break;
      }
      ctx.log(`   ${errors.join(" ")}`);
    }
  }

  const currentSchedule = current.worker.schedule;
  const limitPickup = await yesNo(
    `Limit new-task pickup to active hours? [${currentSchedule ? "Y/n" : "y/N"}]: `,
    currentSchedule !== null,
  );
  let activeWindows: string[] = [];
  let blockedWindows: string[] = [];
  let timezone = "";
  if (limitPickup) {
    const existingWindows =
      currentSchedule?.active.map((window) => window.spec).join(",") || "22:00-06:00";
    for (;;) {
      activeWindows = (
        (await ctx.prompt(`Active windows, comma-separated [${existingWindows}]: `)).trim() ||
        existingWindows
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      try {
        activeWindows.forEach(parseTimeWindowSpec);
        break;
      } catch (error) {
        ctx.log(`   ${(error as Error).message}`);
      }
    }
    blockedWindows = currentSchedule?.blocked.map((window) => window.spec) ?? [];
    const existingTimezone = currentSchedule?.timezone ?? "";
    for (;;) {
      timezone =
        (await ctx.prompt(`Timezone [${existingTimezone || "worker machine local"}]: `)).trim() ||
        existingTimezone;
      if (!timezone || isValidTimeZone(timezone)) break;
      ctx.log(`   "${timezone}" is not a valid IANA timezone.`);
    }
  }

  writeWorkerOperatingPolicy(ctx.workspaceDir, {
    ciFailureFix,
    conflictResolution,
    conflictResolutionCron,
    conflictResolutionInterval,
    activeWindows,
    blockedWindows,
    timezone,
    catchUpMissed: currentSchedule?.catchUpMissed ?? true,
  });
  ctx.log("💾 Wrote worker operating policy to workspace.toml.");
}

function applyEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }
  const env = parseEnvContent(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    // Match dotenv's normal precedence: an explicit shell value wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return env;
}

async function defaultEnsureTracker(
  cwd: string,
  prompt: PromptFn,
  log: LogFn,
): Promise<string | null> {
  const projectRoot = findProjectRoot({ startDir: cwd });
  const envPath = resolve(projectRoot, ".devintern-code", ".env");
  if (existsSync(envPath)) {
    const env = applyEnvFile(envPath);
    return (env.TASK_TRACKER || process.env.TASK_TRACKER || "jira").toLowerCase();
  }

  log("   No tracker config in this repo — running that subset of `devintern init`.");
  const result = await runTrackerSetup(prompt, log, defaultProbe, cwd);
  if (!result) {
    return null;
  }
  applyEnvFile(envPath);
  return result.trackerId;
}

function projectAuthConfig(projectRoot: string) {
  return createDefaultSupabaseAuthConfig(
    join(projectRoot, ".devintern-code", ".auth-session.json"),
  );
}

async function defaultGetUser(projectRoot: string): Promise<InitUserLike | null> {
  return getAuthenticatedUser(projectAuthConfig(projectRoot));
}

async function defaultSignIn(projectRoot: string): Promise<InitUserLike | null> {
  const resolved = await resolveLogin(process.argv);
  return login(projectAuthConfig(projectRoot), resolved);
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

async function defaultConnectRelay(options: {
  projectRoot: string;
  workspaceDir: string;
  trackerType: string;
  log: LogFn;
}): Promise<boolean> {
  const getAccessToken = async () => {
    const user = await requireAuthenticatedUser(
      projectAuthConfig(options.projectRoot),
      "devintern login",
    );
    return user.accessToken;
  };
  const deps = { workingDir: options.workspaceDir, getAccessToken };
  const workspace = loadWorkspaceConfig(workspaceConfigPath(options.workspaceDir));
  const repos = workspaceGitHubRepos(workspace);
  let ok = true;

  if (repos.length > 0) {
    for (const repo of repos) {
      const repoOk = (await connectRelayTarget("github", { ...deps, repo })) === 0;
      ok = repoOk && ok;
    }
  } else {
    options.log("   No GitHub remote detected; skipping GitHub relay registration.");
  }

  if (options.trackerType !== "github" && options.trackerType !== "markdown") {
    const trackerOk = (await connectRelayTarget(options.trackerType, deps)) === 0;
    ok = trackerOk && ok;
  }

  return ok;
}

/**
 * Run the guided worker setup.
 *
 * @returns ok when setup completed and the workspace was written
 */
export async function runWorkerInit(deps: WorkerInitDeps = {}): Promise<WorkerInitResult> {
  const cwd = deps.cwd ?? process.cwd();
  const projectRoot = findProjectRoot({ startDir: cwd });
  const log = deps.log ?? console.log;
  const abort = { ok: false };

  let rl: import("node:readline/promises").Interface | undefined;
  let prompt = deps.prompt;
  if (!prompt) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question: string) => rl!.question(question);
  }

  try {
    log("👷 Setting up the unattended devintern worker.");

    // 1. Reuse tracker config from `devintern init`, or run that subset.
    log("\n1️⃣  Tracker configuration");
    const trackerType = deps.ensureTracker
      ? await deps.ensureTracker({ cwd, prompt, log })
      : await defaultEnsureTracker(cwd, prompt, log);
    if (!trackerType) {
      log("❌ Tracker setup did not finish. Re-run `devintern worker init`.");
      return abort;
    }
    const capabilities = TRACKER_CAPABILITIES[trackerType];
    if (!supportsPolling(trackerType)) {
      log(`❌ Tracker '${trackerType}' does not support worker polling.`);
      log(`   Pollable trackers: ${trackersSupportingPolling().join(", ")}`);
      return abort;
    }
    const trackerName = capabilities?.displayName ?? trackerType;
    log(`   Using ${trackerName}.`);

    // 2. Write a workspace (import this repo). Query lands after the dry run.
    log("\n2️⃣  Workspace (one daemon; this repo first)");
    const bootstrap =
      deps.bootstrapWorkspace ??
      (async (opts) => {
        const result = await ensureWorkspaceAndAddRepo(opts.cwd, opts.log);
        if (!result.ok) {
          return { error: result.error };
        }
        return {
          workspaceDir: result.workspaceDir,
          created: result.created,
          repoName: result.repoName,
        };
      });
    const workspace = await bootstrap({ cwd, log });
    if ("error" in workspace) {
      log(`❌ ${workspace.error}`);
      return abort;
    }
    const workspaceDir = workspace.workspaceDir;
    if (workspace.created === false) {
      const existing = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
      if (existing.defaults.tracker !== trackerType) {
        log(
          `❌ This workspace uses ${existing.defaults.tracker}, but this repo is configured for ${trackerType}.`,
        );
        log("   One worker workspace has one active tracker; keep its defaults unchanged.");
        return abort;
      }
    }

    // 3. Ready-tasks query, validated with a live dry run, then task_query.
    log("\n3️⃣  Which tasks should the worker pick up?");
    log("   The query uses the same language as 'devintern --query' for your tracker.");
    if (capabilities?.queryExample) {
      log(`   Example: ${capabilities.queryExample}`);
    }

    let query = "";
    for (;;) {
      query = (await prompt("Ready-tasks query: ")).trim();
      if (!query) {
        log("❌ A query is required — it defines what 'ready for the agent' means.");
        continue;
      }
      if (!deps.dryRunQuery) {
        break;
      }
      try {
        const count = await deps.dryRunQuery(query);
        log(`✅ Query works: ${count} task(s) match right now.`);
        if (count === 0) {
          log("   (0 matches is fine if nothing is ready yet — the worker will poll.)");
        }
        break;
      } catch (error) {
        log(`❌ Query failed against ${trackerName}: ${(error as Error).message}`);
        const retry = (await prompt("Edit the query and try again? [Y/n]: ")).trim().toLowerCase();
        if (retry === "n" || retry === "no") {
          log("   Keeping the query as entered; fix it later in workspace.toml.");
          break;
        }
      }
    }

    writeWorkspaceDefaults(workspaceDir, { tracker: trackerType, taskQuery: query });
    log(`💾 Wrote [defaults].task_query to ${join(workspaceDir, "workspace.toml")}`);

    // 4. Make consequential unattended behavior explicit instead of silently
    // accepting token-spending defaults.
    log("\n4️⃣  Worker operating policy");
    log("   Choose when new tasks run and how the worker maintains its pull requests.");
    await (deps.configureOperatingPolicy ?? configureWorkerOperatingPolicy)({
      workspaceDir,
      prompt,
      log,
    });

    // 5. Optional production-error source. Tracker tasks remain the worker's
    // primary input; this adds a repo-pinned Sentry project alongside them.
    log("\n5️⃣  Sentry auto-fixes (optional)");
    log("   Watch recurring production errors and run fixes through the normal PR pipeline.");
    const sentryAnswer = (
      await prompt("Watch a Sentry project and create fixes for recurring errors? [y/N]: ")
    )
      .trim()
      .toLowerCase();
    if (sentryAnswer === "y" || sentryAnswer === "yes") {
      await runWorkerSentrySetup({
        workspaceDir,
        repoName: workspace.repoName,
        prompt,
        log,
        validateSentry: deps.validateSentry,
      });
    } else {
      log("   Sentry auto-fixes skipped; add [[error_monitors]] to workspace.toml later.");
    }

    // 6. Automation license — any SKU; do not special-case workspace.
    if (deps.checkAutomationLicense) {
      log("\n6️⃣  Checking your automation license (the worker runs unattended)...");
      try {
        const failure = await deps.checkAutomationLicense();
        if (failure === null) {
          log("✅ Automation license OK.");
        } else {
          log(`⚠️  ${failure}`);
          log("   The worker will refuse to start until this is fixed:");
          log("   get a Supporter, Team, or Business key at https://devintern.com/pricing");
          log("   and set LICENSE_KEY in .devintern-code/.env (or sign in).");
        }
      } catch (error) {
        log(
          `⚠️  License check errored (${(error as Error).message}); the worker re-checks at startup.`,
        );
      }
    }

    // 7. Relay: polling remains the correctness layer, while a signed-in
    // worker can receive GitHub/tracker envelopes within seconds.
    let relayConnected = hasGitHubRelayRegistration(loadRelayState(workspaceDir));
    log("\n7️⃣  Instant events (optional; polling always stays on)");
    const relayAnswer = (
      await prompt("React in seconds through the DevIntern relay, without opening a port? [Y/n]: ")
    )
      .trim()
      .toLowerCase();
    if (relayAnswer !== "n" && relayAnswer !== "no") {
      const getUser = deps.getUser ?? defaultGetUser;
      const signIn = deps.signIn ?? defaultSignIn;
      let user: InitUserLike | null = null;
      try {
        user = await getUser(projectRoot);
      } catch {
        user = null;
      }

      if (!user) {
        const loginAnswer = (await prompt("Sign in now to connect the relay? [Y/n]: "))
          .trim()
          .toLowerCase();
        if (loginAnswer !== "n" && loginAnswer !== "no") {
          try {
            user = await signIn(projectRoot);
            if (user) {
              log(`✅ Signed in as ${user.email || user.id}.`);
            }
          } catch (error) {
            log(`⚠️  Sign-in failed: ${(error as Error).message}`);
          }
        }
      } else {
        log(`   Signed in as ${user.email || user.id}.`);
      }

      if (user) {
        const connectRelay = deps.connectRelay ?? defaultConnectRelay;
        try {
          const connected = await connectRelay({
            projectRoot,
            workspaceDir,
            trackerType,
            log,
          });
          relayConnected = connected || hasGitHubRelayRegistration(loadRelayState(workspaceDir));
          if (connected) {
            log(`✅ Relay pairing stored under ${workspaceDir}.`);
          } else {
            log(
              "⚠️  Some relay sources did not connect. Polling still works; retry with worker connect.",
            );
          }
        } catch (error) {
          log(`⚠️  Relay setup failed: ${(error as Error).message}`);
          log("   Polling still works; relay only improves event latency.");
        }
      } else {
        log("   Relay skipped. Run `devintern login`, then re-run `devintern worker init` later.");
      }
    } else {
      log("   Relay skipped. Polling will still pick up ready tasks and review feedback.");
    }

    // 8. GitHub App: relay-backed workspaces install the central App and keep
    // GitHub API access local through GITHUB_TOKEN. A customer-owned App is an
    // advanced, no-relay path for air-gapped/direct installations only.
    let githubAppOutcome: "connected" | "existing" | "skipped" | "unavailable" = "unavailable";
    const detectGithubRepo = deps.detectGithubRepo ?? detectGitHubRepo;
    let githubRepo: string | null = null;
    try {
      githubRepo = await detectGithubRepo();
    } catch {
      githubRepo = null;
    }

    if (!githubRepo) {
      log("\n8️⃣  GitHub App (@mentions)");
      log("   No GitHub remote detected; skipping the GitHub App step.");
    } else if (!relayConnected) {
      log(`\n8️⃣  GitHub App on ${githubRepo} (advanced no-relay mode)`);
      if (hasGitHubAppCredentials()) {
        githubAppOutcome = "existing";
        log("✅ Customer-owned GitHub App credentials found in the environment.");
        log("   The worker will use that App for polling, @mentions, and GitHub API calls.");
      } else {
        githubAppOutcome = "skipped";
        log("   Relay is not connected, so the hosted DevIntern App cannot deliver events here.");
        log("   GITHUB_TOKEN still supports task PRs and review polling on the worker's own PRs.");
        log(
          "   For air-gapped @mentions or direct webhooks, configure a customer-owned GitHub App",
        );
        log("   with GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY_PATH/BASE64.");
      }
    } else {
      log(`\n8️⃣  DevIntern AI GitHub App on ${githubRepo} (@mentions)`);
      log("   The central App delivers events through the relay; your GITHUB_TOKEN remains local");
      log("   and handles GitHub API reads/writes. No App ID or private key is needed here.");
      log("   @devintern-ai mentions on any PR then react through the relay in seconds.");
      const existing = loadGitHubAppRecord(workspaceDir, githubRepo);
      if (
        existing?.enabled &&
        existing.repo === githubRepo.toLowerCase() &&
        typeof existing.installationId === "number" &&
        typeof existing.repositoryId === "number"
      ) {
        githubAppOutcome = "existing";
        log(
          `✅ GitHub App already verified for ${existing.repo} (${existing.connectedAt ?? "unknown date"}).`,
        );
      } else {
        githubAppOutcome = "skipped";
        log("   No verified GitHub App pairing was recorded.");
        log("   Run: devintern worker connect github");
        log("   The relay verifies the installation before it enables event routing.");
      }
    }

    // 9. Offer to install and launch the native user service. The foreground
    // command remains an honest supported path on every platform, and a
    // declined offer (or a failed automatic install) keeps the manual
    // write-definition-and-print-instructions path alive.
    log("\n9️⃣  Background service (optional)");
    const platform = deps.platform ?? process.platform;
    const writeFile = deps.writeFile ?? ((path, content) => writeFileSync(path, content, "utf8"));
    const execPath = deps.execPath ?? (process.argv[1] ? resolve(process.argv[1]) : "devintern");
    const runtimePath = deps.runtimePath ?? process.execPath;
    const environmentPath = deps.environmentPath ?? process.env.PATH ?? "";
    let serviceRunning = false;

    const printManualServicePath = () => {
      if (platform !== "linux" && platform !== "darwin") {
        log(`   No generated service definition for ${platform}; run the worker in a terminal.`);
        return;
      }
      if (platform === "linux") {
        const unitPath = join(workspaceDir, SYSTEMD_UNIT_NAME);
        writeFile(
          unitPath,
          renderSystemdUnit({ execPath, projectDir: workspaceDir, runtimePath, environmentPath }),
        );
        log(`💾 Wrote ${unitPath}`);
      } else {
        const plistPath = join(workspaceDir, LAUNCHD_PLIST_NAME);
        writeFile(
          plistPath,
          renderLaunchdPlist({ execPath, workingDir: workspaceDir, runtimePath, environmentPath }),
        );
        log(`💾 Wrote ${plistPath}`);
      }
      log("   Install it yourself with:");
      for (const line of manualServiceInstructions({ platform, workspaceDir })) {
        log(`     ${line}`);
      }
    };

    if (platform !== "linux" && platform !== "darwin") {
      log(`   No generated service definition for ${platform}; run the worker in a terminal.`);
    } else if (deps.noService) {
      log("   Skipped (--no-service); `devintern worker` runs the same daemon in a terminal.");
    } else {
      const serviceDeps: WorkerServiceDeps = {
        platform,
        homedir: deps.homedir,
        uid: deps.uid,
        run: deps.run,
      };
      const state = deps.detectService
        ? await deps.detectService()
        : await detectWorkerService(serviceDeps);
      let accepted = false;
      if (state.installed && !state.managed) {
        serviceRunning = state.active;
        log("⚠️  The installed service has custom settings and will not be overwritten.");
        printManualServicePath();
      } else if (state.installed) {
        const offer = state.active ? "restart and update" : "update";
        const bootSuffix = platform === "linux" ? " and ensure it starts at boot" : "";
        const answer = (
          await prompt(
            `A devintern-worker service is already installed. ${offer} it${bootSuffix} now? [Y/n]: `,
          )
        )
          .trim()
          .toLowerCase();
        accepted = answer !== "n" && answer !== "no";
      } else {
        const action =
          platform === "linux"
            ? "Install and start the background service at boot now? [Y/n]: "
            : "Install and start the background service now? [Y/n]: ";
        const answer = (await prompt(action)).trim().toLowerCase();
        accepted = answer !== "n" && answer !== "no";
      }
      if (state.installed && !state.managed) {
        // Leave custom definitions and their running processes untouched.
      } else if (!accepted) {
        printManualServicePath();
      } else {
        const result = deps.installService
          ? await deps.installService({
              workspaceDir,
              execPath,
              runtimePath,
              environmentPath,
              log,
            })
          : await installWorkerService(
              { workspaceDir, execPath, runtimePath, environmentPath },
              serviceDeps,
            );
        if (result.ok) {
          serviceRunning = true;
          log(
            result.updated
              ? "✅ devintern-worker service updated and restarted."
              : "✅ devintern-worker service installed and running.",
          );
          log("   Open http://localhost:4400 to verify worker status and runs.");
          if (result.warning) {
            log(`⚠️  ${result.warning}`);
          }
          log(
            platform === "linux"
              ? result.warning
                ? "   Run `loginctl enable-linger` to start the worker at boot before login."
                : "   User lingering was enabled so the service starts at boot and survives logout."
              : "   Stop it with: launchctl bootout gui/$(id -u)/com.devintern.worker",
          );
        } else {
          log(`❌ Could not install the service automatically: ${result.error}`);
          log("   Nothing was left half-installed. Install it manually:");
          printManualServicePath();
        }
      }
    }

    log("\n🎉 Worker setup complete!");
    log("\n📝 Next steps:");
    if (serviceRunning) {
      log("   1. The worker is already running as your user service.");
    } else {
      log("   1. Run `devintern worker`.");
    }
    log("   2. Open http://localhost:4400 to see worker status and runs.");
    log("   3. Tasks matching your query use managed clones — your checkout is left alone.");
    if (githubAppOutcome === "skipped") {
      if (relayConnected) {
        log("\n⚠️  Central GitHub App events are not enabled:");
        log(
          `   @mentions on PRs this worker did not create will not fire. Install ${GITHUB_APP_INSTALL_URL}`,
        );
        log(
          "   on your repositories, then re-run `devintern worker init` (or `devintern worker connect`).",
        );
      } else {
        log("\nℹ️  Running without relay or a custom GitHub App:");
        log("   GITHUB_TOKEN polling still handles the worker's own PRs.");
        log("   See the advanced GitHub integration guide if this installation must stay offline.");
      }
    }
    return { ok: true };
  } finally {
    rl?.close();
  }
}
