/**
 * Interactive `devintern worker init`: guided unattended-worker setup.
 *
 * Writes a workspace (first import is N=1) instead of `WORKER_TASK_QUERY` in
 * `.env`, dry-runs the ready-tasks query, and checks any automation license.
 * Polling is always on; direct webhooks run as a separate advanced service.
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

import { runTrackerSetup } from "./init-wizard";
import { PRManager } from "./pr-client";
import { runWorkerConnect } from "./relay-connect";
import {
  TRACKER_CAPABILITIES,
  supportsPolling,
  trackersSupportingPolling,
} from "./tracker-capabilities";
import { ensureWorkspaceAndImport, writeWorkspaceDefaults } from "./workspace/init";
import { loadWorkspaceConfig } from "./workspace/config";
import { workspaceConfigPath } from "./workspace/paths";

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

/**
 * Render a systemd service unit for the worker.
 *
 * @param options - Binary path, working directory, and whether to run the direct webhook service
 */
export function renderSystemdUnit(options: {
  execPath: string;
  projectDir: string;
  listen?: boolean;
}): string {
  const command = options.listen ? "webhook serve" : "worker";
  const quote = (value: string) =>
    /^[A-Za-z0-9_./:-]+$/.test(value)
      ? value.replace(/%/g, "%%")
      : `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=devintern ${options.listen ? "webhook server" : "worker"} (${options.projectDir})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quote(options.projectDir)}
ExecStart=${quote(options.execPath)} ${command}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render a per-user macOS launchd agent for the workspace worker. */
export function renderLaunchdPlist(options: {
  execPath: string;
  workingDir: string;
  label?: string;
}): string {
  const label = options.label ?? "com.devintern.worker";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.execPath)}</string>
    <string>worker</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(options.workingDir, "worker.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(options.workingDir, "worker.stderr.log"))}</string>
</dict>
</plist>
`;
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
  }) => Promise<{ workspaceDir: string; created?: boolean } | { error: string }>;
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
  /** Platform override for service-file tests. */
  platform?: NodeJS.Platform;
  /** Worker executable written into service definitions. */
  execPath?: string;
  /** File writer override for tests. */
  writeFile?: (path: string, content: string) => void;
}

interface InitUserLike {
  id: string;
  email: string | null;
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
  const repo = await detectGitHubRepo();
  let ok = true;

  if (repo) {
    ok =
      (await runWorkerConnect(["github", "--repo", repo], () => Promise.resolve(repo), deps)) === 0;
  } else {
    options.log("   No GitHub remote detected; skipping GitHub relay registration.");
  }

  if (options.trackerType !== "github" && options.trackerType !== "markdown") {
    const trackerOk =
      (await runWorkerConnect([options.trackerType], () => Promise.resolve(repo), deps)) === 0;
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
        const result = await ensureWorkspaceAndImport(opts.cwd, opts.log);
        if (!result.ok) {
          return { error: result.error };
        }
        return { workspaceDir: result.workspaceDir, created: result.created };
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

    // 4. Automation license — any SKU; do not special-case workspace.
    if (deps.checkAutomationLicense) {
      log("\n4️⃣  Checking your automation license (the worker runs unattended)...");
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

    // 5. Relay: polling remains the correctness layer, while a signed-in
    // worker can receive GitHub/tracker envelopes within seconds.
    log("\n5️⃣  Instant events (optional; polling always stays on)");
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

    // 6. Write, but do not install, the native user-service definition. The
    // foreground command remains an honest supported path on every platform.
    log("\n6️⃣  Background service (optional)");
    const serviceAnswer = (await prompt("Write a background service definition? [Y/n]: "))
      .trim()
      .toLowerCase();
    const platform = deps.platform ?? process.platform;
    const writeFile = deps.writeFile ?? ((path, content) => writeFileSync(path, content, "utf8"));
    const execPath = deps.execPath ?? process.argv[1] ?? "devintern";
    if (serviceAnswer !== "n" && serviceAnswer !== "no") {
      if (platform === "linux") {
        const unitPath = join(workspaceDir, "devintern-worker.service");
        writeFile(unitPath, renderSystemdUnit({ execPath, projectDir: workspaceDir }));
        log(`💾 Wrote ${unitPath}`);
        log("   Install as your user with:");
        log("     mkdir -p ~/.config/systemd/user");
        log(`     cp ${unitPath} ~/.config/systemd/user/devintern-worker.service`);
        log("     systemctl --user daemon-reload");
        log("     systemctl --user enable --now devintern-worker");
      } else if (platform === "darwin") {
        const plistPath = join(workspaceDir, "com.devintern.worker.plist");
        writeFile(plistPath, renderLaunchdPlist({ execPath, workingDir: workspaceDir }));
        log(`💾 Wrote ${plistPath}`);
        log("   Install for your macOS user with:");
        log("     mkdir -p ~/Library/LaunchAgents");
        log(`     cp ${plistPath} ~/Library/LaunchAgents/com.devintern.worker.plist`);
        log(
          "     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.devintern.worker.plist",
        );
      } else {
        log(`   No generated service definition for ${platform}; run the worker in a terminal.`);
      }
    } else {
      log("   Service skipped; `devintern worker` runs the same daemon in this terminal.");
    }

    log("\n🎉 Worker setup complete!");
    log("\n📝 Next steps:");
    log("   1. Run `devintern worker`.");
    log("   2. Open http://localhost:4400 to see worker status and runs.");
    log("   3. Tasks matching your query use managed clones — your checkout is left alone.");
    return { ok: true };
  } finally {
    rl?.close();
  }
}
