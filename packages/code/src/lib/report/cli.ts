/**
 * `devintern report` — file a bug report from the terminal.
 *
 * The command never enforces a license: reporting must work when the license,
 * sign-in, or tracker configuration is exactly what is broken. It collects a
 * redacted diagnostic bundle, shows a preview, and submits to the DevIntern
 * report endpoint; a failed submission is saved locally for `--from`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { detectInstallKind } from "@devintern/utils";
import { VERSION, loadEnvironment } from "../cli/bootstrap";
import { resolveRuntimeStateDir } from "../config/config-dir";
import { createBugReporter } from "./api";
import { resolveReportDir } from "./paths";
import { DEFAULT_REPORT_ENDPOINT, ReportSubmitError } from "./client";
import { resolveIdentity } from "./identity";
import { readStoredIdentity } from "./session";
import {
  findSpoolEntry,
  findSpoolEntryFile,
  isBugReportPayload,
  isSpoolEntry,
  listSpoolEntries,
  markSpoolError,
  markSpoolSubmitted,
  pruneSpool,
  readSpoolFile,
  saveSpoolEntry,
} from "./store";
import type { BugReportPayload, PreparedReport } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ReportCliOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
  last: boolean;
  runId?: number;
  taskKey?: string;
  logPaths: string[];
  diagnostics: boolean;
  logs: boolean;
  email?: string;
  print: boolean;
  save?: string;
  from?: string;
  yes: boolean;
  json: boolean;
  endpoint?: string;
  shareIdentifiers: boolean;
  help: boolean;
  show?: string;
  list: boolean;
}

function usage(): string {
  return `Usage: devintern report [options]

File a bug report for DevIntern itself. The report includes a redacted
environment summary and, when requested, a recent run and log tails. Task
descriptions, prompts, diffs, environment values, and credentials are never
sent.

Options:
  --title <text>        Report title (prompted when omitted)
  --body <text>         Description (prompted when omitted)
  --body-file <path>    Read the description from a file; '-' reads stdin
  --last                Attach the most recent failed or escalated run
  --run <id>            Attach a specific local run id
  --task <KEY>          Attach the latest run for a task key
  --log <path>          Attach a log tail (repeatable)
  --no-logs             Do not attach log text
  --no-diagnostics      Skip run metadata and logs
  --email <address>     Contact address for an anonymous report
  --share-identifiers   Include the task key and repository slug
  --print               Print the redacted payload and exit (no network)
  --save <path>         Write the payload to a file and exit (no network)
  --from <path>         Submit a previously saved payload
  --yes, -y             Skip the confirmation prompt
  --json                Machine-readable output on stdout
  --endpoint <url>      Override the report endpoint
  -h, --help            Show this help

Subcommands:
  devintern report list         List locally saved reports
  devintern report show <id>    Show a locally saved report

Examples:
  devintern report
  devintern report --last --log ./run.log
  devintern report --title "Worker stops" --body-file ./notes.md --yes
  devintern report --last --print
  devintern report --from .devintern-code/reports/report-....json
`;
}

/** Parse argv into the command options, rejecting unknown flags. */
export function parseReportArgs(argv: string[]): ReportCliOptions {
  const options: ReportCliOptions = {
    last: false,
    logPaths: [],
    diagnostics: true,
    logs: true,
    print: false,
    yes: false,
    json: false,
    shareIdentifiers: false,
    help: false,
    list: false,
  };
  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--title":
        options.title = takeValue(i, arg);
        i++;
        break;
      case "--body":
        options.body = takeValue(i, arg);
        i++;
        break;
      case "--body-file":
        options.bodyFile = takeValue(i, arg);
        i++;
        break;
      case "--last":
        options.last = true;
        break;
      case "--run": {
        const value = Number.parseInt(takeValue(i, arg), 10);
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error("--run needs a positive integer id");
        }
        options.runId = value;
        i++;
        break;
      }
      case "--task":
        options.taskKey = takeValue(i, arg);
        i++;
        break;
      case "--log":
        options.logPaths.push(takeValue(i, arg));
        i++;
        break;
      case "--no-diagnostics":
        options.diagnostics = false;
        break;
      case "--no-logs":
        options.logs = false;
        break;
      case "--email":
        options.email = takeValue(i, arg);
        i++;
        break;
      case "--print":
        options.print = true;
        break;
      case "--save":
        options.save = takeValue(i, arg);
        i++;
        break;
      case "--from":
        options.from = takeValue(i, arg);
        i++;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--endpoint":
        options.endpoint = takeValue(i, arg);
        i++;
        break;
      case "--share-identifiers":
        options.shareIdentifiers = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "list":
        options.list = true;
        break;
      case "show":
        options.show = takeValue(i, arg);
        i++;
        break;
      default:
        throw new Error(`Unknown option '${arg}'`);
    }
  }
  return options;
}

/** Read a body from `--body-file` (or stdin for `-`). */
function readBodyFile(path: string): string {
  if (path === "-") {
    return readFileSync(0, "utf8");
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Body file not found: ${resolved}`);
  }
  return readFileSync(resolved, "utf8");
}

/** Format a byte count for the preview. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Write a raw payload to a user-selected path. */
function savePayloadTo(path: string, payload: BugReportPayload): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

/** Read a saved payload or spool entry from a path. */
function readPayloadFile(path: string): BugReportPayload | null {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolved, "utf8"));
    if (isBugReportPayload(parsed)) return parsed;
    if (isSpoolEntry(parsed)) return parsed.payload;
    return null;
  } catch {
    return null;
  }
}

/** Print a short summary of a saved report. */
function printSpoolEntry(entry: ReturnType<typeof readSpoolFile>): void {
  if (!entry) return;
  const { payload } = entry;
  console.log(`${payload.reportId}  ${entry.status}`);
  console.log(`  Title: ${payload.title}`);
  console.log(`  Saved: ${entry.savedAt}`);
  if (entry.submittedAt) console.log(`  Sent:  ${entry.submittedAt}`);
  if (entry.url) console.log(`  URL:   ${entry.url}`);
  if (entry.receipt) console.log(`  Receipt: ${entry.receipt}`);
  if (entry.error) console.log(`  Last error: ${entry.error}`);
}

/** Prompt for one line, returning null on EOF. */
async function promptLine(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** Prompt for a multiline description terminated by a lone dot. */
async function promptMultiline(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    console.log("Description (end with a line containing only '.'):");
    for (;;) {
      const line = await rl.question("");
      if (line.trim() === ".") break;
      lines.push(line);
    }
    return lines.join("\n").trim();
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** Human-readable preview of what the payload contains. */
function renderPreview(payload: BugReportPayload, bytes: number): string {
  const lines = ["", "Attachments:"];
  lines.push(
    `  ✓ environment: devintern ${payload.environment.cliVersion}, ` +
      `${payload.environment.runtime.os}/${payload.environment.runtime.arch}` +
      (payload.environment.harness ? `, harness ${payload.environment.harness.name}` : ""),
  );
  const run = payload.context?.run;
  if (run) {
    lines.push(
      `  ✓ run #${run.id ?? "?"}: ${run.status}` +
        (run.failedStep ? ` at ${run.failedStep}` : "") +
        (run.durationMs !== undefined ? `, ${Math.round(run.durationMs / 1000)}s` : ""),
    );
  }
  const logs = payload.context?.logs ?? [];
  if (logs.length > 0) {
    const logBytes = Buffer.byteLength(JSON.stringify(logs), "utf8");
    lines.push(`  ✓ logs: ${logs.length} attachment(s), ${formatBytes(logBytes)}`);
  }
  if (payload.context?.evidence?.length) {
    lines.push(`  ✓ evidence: ${payload.context.evidence.length} item(s)`);
  }
  lines.push("  ✗ never sent: task description, prompts, diffs, env values, credentials");
  lines.push(
    payload.context?.run?.taskKey
      ? "  • identifiers: task key and repository included"
      : "  • identifiers: task key and repository redacted",
  );
  lines.push("", `Payload: ${formatBytes(bytes)}`);
  return lines.join("\n");
}

/** Best-effort install kind for triage. */
function currentInstallKind(): string {
  try {
    return detectInstallKind({
      scriptPath: process.argv[1] ?? "",
      packageName: "@getdevintern/code",
    });
  } catch {
    return "unknown";
  }
}

/** Print a report and exit. */
function finish(code: number): never {
  process.exit(code);
}

/** List locally saved reports. */
function handleList(reportDir: string, json: boolean): never {
  const entries = listSpoolEntries(reportDir).slice(0, 20);
  if (json) {
    console.log(
      JSON.stringify(
        entries.map((entry) => ({
          id: entry.payload.reportId,
          title: entry.payload.title,
          status: entry.status,
          savedAt: entry.savedAt,
          ...(entry.url ? { url: entry.url } : {}),
        })),
        null,
        2,
      ),
    );
    finish(0);
  }
  if (entries.length === 0) {
    console.log("No locally saved reports.");
    finish(0);
  }
  for (const entry of entries) {
    console.log(
      `${entry.payload.reportId.slice(0, 8)}  ${entry.status.padEnd(9)}  ` +
        `${entry.savedAt}  ${entry.payload.title}`,
    );
  }
  finish(0);
}

/** Show one locally saved report. */
function handleShow(reportDir: string, id: string, json: boolean): never {
  const entry = findSpoolEntry(reportDir, id);
  if (!entry) {
    console.error(`❌ No local report matches '${id}'.`);
    finish(1);
  }
  if (json) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    printSpoolEntry(entry);
  }
  finish(0);
}

/** Resolve title and description from flags or interactive prompts. */
async function resolveDraftText(
  options: ReportCliOptions,
  interactive: boolean,
): Promise<{ title: string; description: string }> {
  let title = options.title?.trim();
  if (!title && interactive) {
    title = (await promptLine("Title: "))?.trim() ?? "";
  }
  if (!title) {
    console.error("❌ A report title is required (--title).");
    finish(2);
  }

  let description = options.body;
  if (options.bodyFile) {
    try {
      description = readBodyFile(options.bodyFile);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      finish(1);
    }
  }
  if (description === undefined && interactive) {
    description = (await promptMultiline()) ?? undefined;
  }
  const trimmed = description?.trim();
  if (!trimmed) {
    console.error("❌ A description is required (--body or --body-file).");
    finish(2);
  }
  return { title, description: trimmed };
}

/** Require a contact email for anonymous submissions. */
async function resolveContactEmail(
  options: ReportCliOptions,
  signedIn: boolean,
  interactive: boolean,
): Promise<string | undefined> {
  let email = options.email?.trim();
  const needsContact = !signedIn && !options.print && !options.save;
  if (needsContact && !email && interactive) {
    email = (await promptLine("Contact email (so we can follow up): "))?.trim();
  }
  if (needsContact && (!email || !EMAIL_PATTERN.test(email))) {
    console.error(
      "❌ Anonymous reports need a valid contact email. " +
        "Use --email <address> or run `devintern login`.",
    );
    finish(2);
  }
  return email;
}

/** Submit a prepared payload and persist the outcome. */
async function submitReport(
  reporter: ReturnType<typeof createBugReporter>,
  prepared: PreparedReport,
  context: { options: ReportCliOptions; reportDir: string },
): Promise<never> {
  const { options, reportDir } = context;
  const reportId = prepared.payload.reportId;
  let savedPath = findSpoolEntryFile(reportDir, reportId)?.path;
  if (!savedPath) {
    savedPath = saveSpoolEntry(reportDir, prepared.payload);
  }
  try {
    const result = await reporter.submitPrepared(prepared);
    markSpoolSubmitted(reportDir, reportId, result);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(`\n✅ Sent report ${result.id}`);
      if (result.url) console.log(`   ${result.url}`);
      if (result.receipt) {
        console.log(`   Receipt: ${result.receipt}`);
        console.log("   Keep the receipt to check status without signing in.");
      }
      console.log("   A saved copy is in your local report history (`devintern report list`).");
    }
    finish(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markSpoolError(reportDir, reportId, message);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message, savedPath }));
    } else {
      console.error(`\n❌ ${message}`);
      if (error instanceof ReportSubmitError && error.status === 401) {
        console.error("   Your sign-in may have expired. Run `devintern login` and retry.");
        console.error("   To file anonymously instead, run `devintern logout` and add --email.");
      }
      console.error(`   Saved the report to ${savedPath}`);
      console.error(`   Retry with: devintern report --from ${savedPath}`);
    }
    finish(1);
  }
}

/** Handle `--from`: resubmit an already prepared payload. */
async function handleFrom(
  options: ReportCliOptions,
  from: string,
  configDir: string,
  reportDir: string,
): Promise<never> {
  const payload = readPayloadFile(from);
  if (!payload) {
    console.error(`❌ ${from} is not a saved DevIntern report.`);
    finish(1);
  }
  if (options.print) {
    console.log(JSON.stringify(payload, null, 2));
    finish(0);
  }
  if (options.save) {
    const path = savePayloadTo(options.save, payload);
    console.log(`💾 Saved report payload to ${path}`);
    finish(0);
  }
  const identity = await resolveIdentity(configDir);
  const reporter = createBugReporter({
    accessToken: identity.accessToken,
    signedIn: identity.signedIn,
    cliVersion: VERSION,
    installKind: currentInstallKind(),
    configDir,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  return submitReport(
    reporter,
    { payload, bytes: Buffer.byteLength(JSON.stringify(payload)) },
    { options, reportDir },
  );
}

/** Ask for confirmation before sending. */
async function confirmSubmission(options: ReportCliOptions, interactive: boolean): Promise<void> {
  if (options.yes) return;
  if (!interactive) {
    console.error(
      "❌ Refusing to submit without confirmation in a non-interactive shell. Use --yes.",
    );
    finish(2);
  }
  const answer = (await promptLine("Send? (Y/n) "))?.trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    console.error("Not sent.");
    finish(0);
  }
}

/** Run the `devintern report` command. */
export async function runReportCommand(argv: string[]): Promise<never> {
  loadEnvironment();

  let options: ReportCliOptions;
  try {
    options = parseReportArgs(argv);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}\n`);
    console.error(usage());
    finish(2);
  }

  if (options.help) {
    console.log(usage());
    finish(0);
  }

  const configDir = resolveRuntimeStateDir();
  const reportDir = resolveReportDir(configDir);
  pruneSpool(reportDir);

  if (options.list) handleList(reportDir, options.json);
  if (options.show) handleShow(reportDir, options.show, options.json);
  if (options.from) return handleFrom(options, options.from, configDir, reportDir);

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const { title, description } = await resolveDraftText(options, interactive);
  const identity =
    options.print || options.save
      ? readStoredIdentity(configDir)
      : await resolveIdentity(configDir);
  const email = await resolveContactEmail(options, identity.signedIn, interactive);

  const reporter = createBugReporter({
    accessToken: identity.accessToken,
    signedIn: identity.signedIn,
    cliVersion: VERSION,
    installKind: currentInstallKind(),
    configDir,
    ...(email ? { contactEmail: email } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });

  let prepared: PreparedReport;
  try {
    prepared = await reporter.prepare({
      title,
      description,
      source: "cli",
      last: options.last,
      runId: options.runId,
      taskKey: options.taskKey,
      logPaths: options.logPaths,
      diagnostics: options.diagnostics,
      logs: options.logs,
      shareIdentifiers: options.shareIdentifiers,
      ...(email ? { contactEmail: email } : {}),
    });
  } catch (error) {
    console.error(`❌ Could not prepare the report: ${(error as Error).message}`);
    finish(1);
  }

  if (options.print) {
    console.log(JSON.stringify(prepared.payload, null, 2));
    finish(0);
  }
  if (options.save) {
    const path = savePayloadTo(options.save, prepared.payload);
    console.log(`💾 Saved report payload to ${path}`);
    finish(0);
  }

  if (!options.json) {
    console.log(`\n🐞 DevIntern bug report\n`);
    console.log(`Title: ${prepared.payload.title}`);
    const descriptionLines = prepared.payload.description.split("\n");
    console.log(
      descriptionLines
        .slice(0, 12)
        .map((line) => `  ${line}`)
        .join("\n") + (descriptionLines.length > 12 ? "\n  …" : ""),
    );
    console.log(renderPreview(prepared.payload, prepared.bytes));
    console.log(`\nDestination: ${options.endpoint ?? DEFAULT_REPORT_ENDPOINT}`);
  }

  await confirmSubmission(options, interactive);
  return submitReport(reporter, prepared, { options, reportDir });
}
