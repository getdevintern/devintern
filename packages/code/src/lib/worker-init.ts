/**
 * Interactive `devintern worker init`: guided server-automation setup on top
 * of an already-initialized project (`devintern init` runs first).
 *
 * Walks the four things unattended runs actually trip on: the ready-tasks
 * query (validated with a live dry run against the tracker), polling vs.
 * webhook mode (generating `WEBHOOK_SECRET` when needed), the automation
 * license (checked now instead of failing at 2am on the first poll), and a
 * ready-to-install systemd unit.
 *
 * Prompt-loop mechanics come from `@devintern/task-trackers` (shared with
 * `devintern init`); everything effectful is injectable for tests.
 */

import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import {
  TRACKER_CAPABILITIES,
  supportsPolling,
  trackersSupportingPolling,
} from "./tracker-capabilities";

export type PromptFn = (question: string) => Promise<string>;
export type LogFn = (message: string) => void;

/** Env keys the worker wizard owns in `.devintern-code/.env`. */
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
 * @param options - Binary path, project directory, and whether to pass --listen
 */
export function renderSystemdUnit(options: {
  execPath: string;
  projectDir: string;
  listen: boolean;
}): string {
  const listenFlag = options.listen ? " --listen" : "";
  return `[Unit]
Description=devintern worker (${options.projectDir})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.projectDir}
ExecStart=${options.execPath} worker${listenFlag}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
`;
}

/** Generate a webhook signing secret (hex, 32 bytes). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export interface WorkerInitDeps {
  prompt?: PromptFn;
  log?: LogFn;
  cwd?: string;
  /** Evaluate the ready-tasks query; returns the number of matching tasks. */
  dryRunQuery?: (query: string) => Promise<number>;
  /** Automation license check; returns a human-readable failure, or null when entitled. */
  checkAutomationLicense?: () => Promise<string | null>;
  /** Injected for tests. */
  writeFile?: (path: string, content: string) => void;
  readFile?: (path: string) => string;
}

/**
 * Run the guided worker setup. Assumes the tracker env is already loaded
 * (the caller runs `loadEnvironment()` first).
 *
 * @returns true when setup completed and config was written
 */
export async function runWorkerInit(deps: WorkerInitDeps = {}): Promise<boolean> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const writeFile = deps.writeFile ?? ((path, content) => writeFileSync(path, content, "utf8"));
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));

  const envPath = resolve(cwd, ".devintern-code", ".env");
  if (!existsSync(envPath)) {
    log("❌ No .devintern-code/.env found in this project.");
    log("   Run 'devintern init' first to configure your tracker, then re-run");
    log("   'devintern worker init'.");
    return false;
  }

  const trackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
  const capabilities = TRACKER_CAPABILITIES[trackerType];
  if (!supportsPolling(trackerType)) {
    log(`❌ Tracker '${trackerType}' does not support worker polling.`);
    log(`   Pollable trackers: ${trackersSupportingPolling().join(", ")}`);
    return false;
  }

  log(`👷 Setting up the devintern worker for ${capabilities?.displayName ?? trackerType}.`);

  let rl: import("node:readline/promises").Interface | undefined;
  let prompt = deps.prompt;
  if (!prompt) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question: string) => rl!.question(question);
  }

  try {
    // 1. Ready-tasks query, validated with a live dry run.
    log("\n1️⃣  Which tasks should the worker pick up?");
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
        log(
          `❌ Query failed against ${capabilities?.displayName ?? trackerType}: ${(error as Error).message}`,
        );
        const retry = (await prompt("Edit the query and try again? [Y/n]: ")).trim().toLowerCase();
        if (retry === "n" || retry === "no") {
          log("   Keeping the query as entered; fix it later in .devintern-code/.env.");
          break;
        }
      }
    }

    // 2. Polling interval.
    const intervalAnswer = (
      await prompt("\n2️⃣  Polling interval in seconds (Enter for 60): ")
    ).trim();
    const interval = /^\d+$/.test(intervalAnswer) ? intervalAnswer : "60";

    // 3. Webhook listener (optional).
    log("\n3️⃣  The worker polls GitHub for review feedback on its own PRs — no");
    log("   webhook needed. Add the webhook listener only if you want instant");
    log("   reactions and can expose a public endpoint.");
    const listenAnswer = (await prompt("Also run the webhook listener? [y/N]: "))
      .trim()
      .toLowerCase();
    const listen = listenAnswer === "y" || listenAnswer === "yes";

    const vars: Record<string, string> = {
      WORKER_TASK_QUERY: query,
      WORKER_POLL_INTERVAL: interval,
    };
    if (listen) {
      vars.WEBHOOK_SECRET = generateWebhookSecret();
      log("🔐 Generated WEBHOOK_SECRET (written to .devintern-code/.env).");
      log("   Paste the same value into your GitHub App's webhook Secret field.");
    }

    // 4. Automation license, checked now instead of on the first poll.
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

    // Write the env changes.
    writeFile(envPath, upsertEnvVars(readFile(envPath), vars));
    log(`\n💾 Worker configuration written to ${envPath}`);

    // 5. Optional systemd unit.
    const unitAnswer = (await prompt("\n5️⃣  Write a systemd service file for the worker? [y/N]: "))
      .trim()
      .toLowerCase();
    if (unitAnswer === "y" || unitAnswer === "yes") {
      const unitPath = join(cwd, ".devintern-code", "devintern-worker.service");
      writeFile(
        unitPath,
        renderSystemdUnit({ execPath: process.argv[1] ?? "devintern", projectDir: cwd, listen }),
      );
      log(`💾 Wrote ${unitPath}`);
      log("   Install it with:");
      log(`     sudo cp ${unitPath} /etc/systemd/system/devintern-worker.service`);
      log("     sudo systemctl enable --now devintern-worker");
      log("     journalctl -u devintern-worker -f");
    }

    log("\n🎉 Worker setup complete!");
    log("\n📝 Next steps:");
    log(`   1. Try it in the foreground: devintern worker${listen ? " --listen" : ""}`);
    log("   2. Tasks matching your query get picked up within one interval.");
    log("   3. Retries: edit the ticket description or add a comment to re-run a task.");
    return true;
  } finally {
    rl?.close();
  }
}
