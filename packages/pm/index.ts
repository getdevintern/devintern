#!/usr/bin/env node

/**
 * CLI utility to create tasks from Figma designs, logs, or prompts
 * and store them in Jira, Linear, Markdown files, or other backends.
 */

import { askConfirm } from "./lib/runtime/stdin.js";
import { getArgs } from "./lib/runtime/args.js";
import { configureTerminalEncoding } from "./lib/runtime/terminal.js";
import { enableEnvProxy, formatCliError } from "./lib/runtime/proxy.js";
import { getModuleDir } from "./lib/runtime/path.js";
import { loadConfig, loadSupabaseConfig, migrateLegacyConfigDir } from "./lib/config";
import { createEngine, DEFAULT_ISSUE_TYPES } from "./lib/engine";
import type { PmEngine, SourceInput } from "./lib/engine";
import { runInteractiveMode } from "./lib/components/interactive";
import { initializeProject } from "./lib/init";
import { isInteractive, runPmInitWizard } from "./lib/init-wizard";
import {
  extractHarnessFlags,
  parseArgs,
  parseEffortValue,
  validateHarnessName,
} from "./lib/parse-args";
import type { CLIArgs, ParsedArgs } from "./lib/parse-args";
import { runConnect } from "./lib/chat/connect";
import { runServe } from "./lib/chat/serve";
import {
  listInstalledHarnesses,
  parseAgentEffort,
  resolveExecutablePathStrict,
  resolveHarness,
} from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";
import { getAuthenticatedUser, login, logout, resolveLogin } from "@devintern/auth";
import {
  captureError,
  flushErrorTracking,
  initErrorTracking,
  maybeOfferCliUpdate,
  resolveConfigDir,
} from "@devintern/utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isInteractiveCancelled, runCreateFlow } from "./lib/create-flow";
import type { InteractiveHandle } from "./lib/create-flow";

// Version is injected at build time via --define; falls back to package.json for `bun run`.
declare const __VERSION__: string;

function readPackageVersion(): string {
  try {
    const pkgPath = join(getModuleDir(import.meta.url), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : readPackageVersion();

/** Read SENTRY_DISABLED from `.devintern-pm/.env` before Sentry init. */
function applySentryOptOutFromEnvFile(): void {
  if (process.env.SENTRY_DISABLED === "1") return;
  try {
    const configDir = resolveConfigDir({ configDirName: ".devintern-pm" });
    const content = readFileSync(join(configDir, ".env"), "utf8");
    const match = /^SENTRY_DISABLED=(.*)$/m.exec(content);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value === "1") process.env.SENTRY_DISABLED = "1";
  } catch {
    // No config dir or unreadable .env — shell env only.
  }
}

/**
 * Read AGENT_EFFORT from the environment (`.devintern-pm/.env` is loaded into
 * process.env by loadConfig() before this runs).
 *
 * @throws {InvalidAgentEffortError} on invalid values, so misconfiguration
 *   fails fast instead of silently ignoring the setting during agent runs.
 */
function resolveEnvEffort(): AgentEffort | undefined {
  return parseAgentEffort(process.env.AGENT_EFFORT);
}

/**
 * CLI entry point: routes commands, runs interactive or batch task creation,
 * and orchestrates agent prompts with the configured task backend.
 *
 * Interactive mode reuses a single Ink session across create-another cycles
 * (success → keypress → wizard start) instead of remounting via recursive main().
 *
 * @returns A promise that resolves when the command completes.
 */
async function main() {
  configureTerminalEncoding();

  // Node's fetch ignores HTTP(S)_PROXY unless told otherwise; enable it before
  // any tracker, license, or update request. No-op without a proxy or on Bun.
  enableEnvProxy();

  // Enable verbose API logging globally when --verbose or -v is passed
  const args = getArgs();
  if (args.includes("--verbose") || args.includes("-v")) {
    process.env.DEVINTERN_VERBOSE = "1";
  }

  if (args.includes("--version") || args.includes("-V")) {
    console.log(VERSION);
    process.exit(0);
  }

  // Extract harness flag up front so the harness can be validated once for
  // both interactive and non-interactive modes.
  const harnessFlags = extractHarnessFlags(args);

  // Migrate legacy .claude-pm directory to .devintern-pm if needed
  await migrateLegacyConfigDir();

  // Sentry error tracking — baked-in DSN unless SENTRY_DISABLED=1 (shell or .env).
  applySentryOptOutFromEnvFile();
  initErrorTracking({
    release: `pm@${VERSION}`,
    environment: process.env.NODE_ENV ?? "production",
  });

  // Parse arguments - null means interactive mode, 'init' means run initialization.
  // Help exits inside parseArgs before any update check.
  const parsedArgs = parseArgs(args);

  // Check npm for a newer global `@getdevintern/pm` before real work.
  // Non-interactive sessions skip install by default.
  await maybeOfferCliUpdate({
    packageName: "@getdevintern/pm",
    binName: "devpm",
    currentVersion: VERSION,
    isInteractive: isInteractive(process.argv, process.stdin),
    confirm: askConfirm,
    noUpdateEnv: "DEVPM_NO_UPDATE",
    autoUpdateEnv: "DEVPM_AUTO_UPDATE",
  });

  if (await handleUtilityCommand(args, parsedArgs)) {
    return;
  }

  // handleUtilityCommand consumed every command sentinel; what remains is a
  // one-shot CLI run or interactive mode.
  const taskArgs = parsedArgs as CLIArgs | null;

  // Validate the harness name (if any) only for modes that actually use it.
  validateHarnessName(harnessFlags.harness);

  let source: SourceInput;
  let epicKey: string | undefined;
  let extraInstructions: string | undefined;
  let promptStyle: "technical" | "pm";
  let decompose: boolean;
  let confirm: boolean;
  let model: string | undefined;
  let issueType: string;
  let projectKey: string | undefined;
  let configForInteractive: Awaited<ReturnType<typeof loadConfig>> | undefined;

  try {
    // Load config early for all operational modes. Interactive use is free
    // under FSL, so pm performs no license check.
    configForInteractive = await loadConfig({
      harnessName: harnessFlags.harness,
    });

    const engine: PmEngine = await createEngine(configForInteractive, {
      // loadConfig() has already loaded .devintern-pm/.env into process.env,
      // so AGENT_MODEL / AGENT_EFFORT from the project config are visible
      // here. The --model / --effort flags win over the environment.
      model: taskArgs?.model ?? process.env.AGENT_MODEL,
      effort: taskArgs?.effort ?? resolveEnvEffort(),
    });

    if (taskArgs === null) {
      await runInteractiveSession(engine, configForInteractive);
      return;
    }

    // CLI mode (one-shot)
    const cliArgs: CLIArgs = taskArgs;
    source = cliArgs.source;
    epicKey = cliArgs.epicKey;
    extraInstructions = cliArgs.extraInstructions;
    promptStyle = cliArgs.promptStyle;
    decompose = cliArgs.decompose;
    confirm = cliArgs.confirm;
    model = cliArgs.model;
    issueType = cliArgs.issueType;
    projectKey = undefined; // CLI mode uses default project
    const attachments = cliArgs.attachments;

    // Config already loaded and verified early
    const config = configForInteractive!;

    await runCreateFlow({
      source,
      epicKey,
      extraInstructions,
      promptStyle,
      decompose,
      confirm,
      model,
      issueType,
      projectKey,
      attachments,
      interactiveHandle: null,
      config,
      engine,
    });
  } catch (error) {
    if (isInteractiveCancelled(error)) {
      console.log("\nBye!");
      process.exit(0);
    }
    captureError(error);
    console.error("\n❌ Error:", formatCliError(error));
    await flushErrorTracking();
    process.exit(1);
  }
}

/** Handle the non-task subcommands; returns true when one ran. */
async function handleUtilityCommand(args: string[], parsedArgs: ParsedArgs): Promise<boolean> {
  // Handle init command: guided wizard in interactive terminals, template
  // scaffold with `--yes` / `--no-interactive` / piped stdin.
  if (parsedArgs === "init") {
    if (isInteractive(process.argv, process.stdin)) {
      process.exitCode = await runPmInitWizard();
    } else {
      await initializeProject();
    }
    return true;
  }

  if (parsedArgs === "serve") {
    const platformFlag = args[args.indexOf("--platform") + 1];
    const modelFlag = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
    let effortFlag: AgentEffort | undefined;
    const effortIndex = args.indexOf("--effort");
    if (effortIndex !== -1) {
      effortFlag = parseEffortValue(args, effortIndex);
    }
    await runServe({
      platforms:
        args.includes("--platform") && (platformFlag === "slack" || platformFlag === "telegram")
          ? [platformFlag]
          : undefined,
      model: modelFlag,
      effort: effortFlag,
    });
    return true;
  }

  if (typeof parsedArgs === "object" && parsedArgs !== null && "connect" in parsedArgs) {
    await runConnect(parsedArgs.connect);
    return true;
  }

  if (parsedArgs === "login") {
    await runLoginCommand();
    return true;
  }

  if (parsedArgs === "logout") {
    const supabaseConfig = await loadSupabaseConfig();
    await logout(supabaseConfig);
    console.log("✅ Signed out");
    return true;
  }

  if (parsedArgs === "whoami") {
    const supabaseConfig = await loadSupabaseConfig();
    const user = await getAuthenticatedUser(supabaseConfig);
    console.log(
      user ? `Signed in as ${user.email || user.id}` : "Not signed in. Run `devpm login`.",
    );
    return true;
  }

  return false;
}

/** Sign in and exit non-zero on failure. */
async function runLoginCommand(): Promise<void> {
  try {
    const supabaseConfig = await loadSupabaseConfig();
    const resolved = await resolveLogin(process.argv);
    const user = await login(supabaseConfig, resolved);
    console.log(`✅ Signed in as ${user.email || user.id}`);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

/**
 * Run the interactive wizard, reusing one Ink session across create-another
 * cycles. Resolves when the user finishes; exits the process on cancel.
 */
async function runInteractiveSession(engine: PmEngine, config: LoadedConfig): Promise<void> {
  console.clear();

  // Fetch projects user has access to
  let projectsData: Array<{ key: string; name: string }> | undefined;
  try {
    projectsData = await engine.listProjects();
  } catch {
    console.error(`⚠️  Warning: Could not fetch projects from ${engine.backendName}`);
  }

  // Determine which project to use for fetching issue types.
  // Prefer the configured default key, but if projectsData is available and the key isn't in
  // it (e.g. misconfigured or no access), fall back to the first accessible project.
  const configuredKey = engine.defaultProjectKey;
  const firstProjectKey =
    projectsData && projectsData.length > 0 ? projectsData[0]?.key : undefined;
  const projectKeyForIssueTypes =
    configuredKey && (!projectsData || projectsData.some((p) => p.key === configuredKey))
      ? configuredKey
      : (firstProjectKey ?? configuredKey);

  // Fetch issue types from backend for the default project (initial load).
  // Only fetch if the backend actually supports issue type selection.
  let issueTypeNames: string[] | undefined;
  if (engine.supportsIssueTypes) {
    try {
      issueTypeNames = await engine.listIssueTypes(projectKeyForIssueTypes);
    } catch (err) {
      // Fetch failed — fall back to defaults so undefined unambiguously means "not supported"
      const reason = err instanceof Error ? err.message : String(err);
      const hint =
        projectsData !== undefined && projectsData.length === 0
          ? " — your API user has no project access; add them to the project in your tracker's settings"
          : "";
      console.error(
        `⚠️  Warning: Could not fetch issue types from ${engine.backendName}, using defaults (${reason}${hint})`,
      );
      issueTypeNames = [...DEFAULT_ISSUE_TYPES];
    }
  }

  let interactiveHandle: InteractiveHandle;
  try {
    const currentHarness = config.agent.harness;
    const installedHarnesses = listInstalledHarnesses({
      currentHarnessName: currentHarness.name,
    });
    // loadConfig() already validated the active harness; keep it in the
    // picker even if detection via PATH alone would miss a custom path.
    const harnessesForPicker = installedHarnesses.some((h) => h.name === currentHarness.name)
      ? installedHarnesses
      : [currentHarness, ...installedHarnesses];
    const harnesses = harnessesForPicker.map((h) => ({
      name: h.name,
      displayName: h.displayName,
    }));
    interactiveHandle = await runInteractiveMode({
      projects: projectsData,
      defaultProjectKey: engine.defaultProjectKey,
      issueTypes: issueTypeNames,
      fetchIssueTypes: engine.supportsIssueTypes
        ? (projectKey: string) => engine.listIssueTypes(projectKey)
        : undefined,
      backendName: engine.backendName,
      harnesses,
      currentHarnessName: config.agent.harness.name,
      supportsEpicLinking: engine.supportsEpicLinking,
    });
  } catch (error) {
    if (isInteractiveCancelled(error)) {
      console.log("\nBye!");
      process.exit(0);
    }
    console.error("\n❌ Interactive mode failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Create-another loop: reuse the same Ink session. Remounting via main()
  // previously left a blank screen (old instance not cleaned up + console.clear).
  while (true) {
    let interactiveConfig;
    try {
      interactiveConfig = await interactiveHandle.waitForCompletion();
    } catch (error) {
      if (isInteractiveCancelled(error)) {
        interactiveHandle.cleanup();
        console.log("\nBye!");
        process.exit(0);
      }
      throw error;
    }

    if (!interactiveConfig.sourceType || !interactiveConfig.sourceContent) {
      console.error("❌ Interactive mode was cancelled or incomplete");
      interactiveHandle.cleanup();
      process.exit(1);
    }

    // Re-resolve harness if user selected a different one in interactive mode.
    // Engine reads config.agent at call time, so mutating config is enough.
    if (
      interactiveConfig.harnessName &&
      interactiveConfig.harnessName !== config.agent.harness.name
    ) {
      validateHarnessName(interactiveConfig.harnessName);
      const resolved = resolveHarness({ harnessName: interactiveConfig.harnessName });
      resolved.path = resolveExecutablePathStrict(resolved.path, resolved.harness.displayName);
      config.agent = resolved;
      // An explicit harness pick disables AGENT_HARNESS failover, like --harness.
      config.agentFallbacks = [];
      config.agentIsFallback = false;
    }

    const shouldContinue = await runCreateFlow({
      source: {
        type: interactiveConfig.sourceType,
        content: interactiveConfig.sourceContent,
      },
      epicKey: interactiveConfig.epicKey,
      extraInstructions: interactiveConfig.customInstructions,
      promptStyle: interactiveConfig.promptStyle,
      decompose: interactiveConfig.decompose,
      confirm: false, // Interactive mode handles confirmation differently
      model: undefined,
      issueType: interactiveConfig.issueType,
      projectKey: interactiveConfig.projectKey,
      interactiveHandle,
      config,
      engine,
    });

    if (!shouldContinue) {
      interactiveHandle.cleanup();
      return;
    }
    // handle.restart() already ran inside runCreateFlow; loop for next task
  }
}

// Global error handlers — report to Sentry (when configured), then exit.
process.on("unhandledRejection", (reason: unknown) => {
  console.error("\n❌ Unhandled error:", reason instanceof Error ? reason.message : reason);
  captureError(reason);
  void flushErrorTracking().finally(() => process.exit(1));
});

process.on("uncaughtException", (error: Error) => {
  console.error("\n❌ Uncaught exception:", error.message);
  captureError(error);
  void flushErrorTracking().finally(() => process.exit(1));
});

// Run CLI mode
main();
