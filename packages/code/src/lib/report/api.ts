/**
 * Public bug-reporting API for `@getdevintern/code/report`.
 *
 * The CLI command and integrations preparing user-approved reports go
 * through this module so redaction, caps, and the payload schema stay in one
 * place. Tests inject `fetchImpl` and `now` to avoid the network and the clock.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { collectDiagnostics } from "./collect";
import { resolveReportConfigDir } from "./paths";
import { DEFAULT_REPORT_ENDPOINT, postReport } from "./client";
import { buildFingerprint } from "./fingerprint";
import { redactReportText } from "./redact";
import type { ReportRedactionOptions } from "./redact";
import type {
  BugReportDraft,
  BugReportPayload,
  BugReporter,
  BugReporterOptions,
  PreparedReport,
  ReportEvidence,
  ReportLogAttachment,
  RunDiagnostics,
  SubmittedReport,
} from "./types";

/** Maximum serialized payload accepted by the endpoint. */
export const MAX_PAYLOAD_BYTES = 240 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_EVIDENCE_CHARS = 16 * 1024;
const MAX_EVIDENCE_ITEMS = 5;

/** Resolve the submission endpoint from options or environment. */
export function resolveReportEndpoint(endpoint?: string): string {
  const configured = endpoint?.trim() || process.env.DEVINTERN_REPORT_URL?.trim();
  return configured || DEFAULT_REPORT_ENDPOINT;
}

/** Serialize a payload for size checks and transport. */
export function serializePayload(payload: BugReportPayload): string {
  return JSON.stringify(payload);
}

/** Drop or shorten optional context until the payload fits the server cap. */
function fitPayload(payload: BugReportPayload): void {
  const byteSize = (): number => Buffer.byteLength(serializePayload(payload), "utf8");
  if (byteSize() <= MAX_PAYLOAD_BYTES) return;

  const logs = payload.context?.logs;
  if (logs) {
    for (const log of logs) {
      if (log.text.length > 32 * 1024) {
        log.text = `${log.text.slice(0, 32 * 1024)}…`;
        log.truncated = true;
      }
    }
    while (byteSize() > MAX_PAYLOAD_BYTES && logs.length > 0) {
      logs.pop();
    }
    if (logs.length === 0 && payload.context) delete payload.context.logs;
  }
  if (byteSize() > MAX_PAYLOAD_BYTES) {
    payload.description = `${payload.description.slice(0, 6000)}…`;
  }
  const evidence = payload.context?.evidence;
  if (evidence) {
    while (byteSize() > MAX_PAYLOAD_BYTES && evidence.length > 0) {
      evidence.pop();
    }
    if (evidence.length === 0 && payload.context) delete payload.context.evidence;
  }
  if (byteSize() > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Report payload exceeds the ${Math.floor(MAX_PAYLOAD_BYTES / 1024)} KB limit. ` +
        "Shorten the description or use --no-logs.",
    );
  }
}

/** Redact and bound caller-supplied evidence. */
function prepareEvidence(
  evidence: ReportEvidence[] | undefined,
  redaction: ReportRedactionOptions,
): ReportEvidence[] | undefined {
  if (!evidence || evidence.length === 0) return undefined;
  return evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({
    key: redactReportText(item.key, { ...redaction, maxChars: 80 }),
    ...(item.title ? { title: redactReportText(item.title, { ...redaction, maxChars: 200 }) } : {}),
    ...(item.mediaType
      ? { mediaType: redactReportText(item.mediaType, { ...redaction, maxChars: 80 }) }
      : {}),
    text: redactReportText(item.text, { ...redaction, maxChars: MAX_EVIDENCE_CHARS }),
  }));
}

/** Redaction options shared by every field in one report. */
function redactionFor(
  draft: BugReportDraft,
  collected: Awaited<ReturnType<typeof collectDiagnostics>>,
  cwd: string,
): ReportRedactionOptions {
  return {
    cwd,
    homeDir: homedir(),
    repoSlug: collected.repoSlug,
    taskKey: draft.taskKey ?? collected.taskKey ?? collected.context?.run?.taskKey ?? null,
    shareIdentifiers: draft.shareIdentifiers ?? false,
  };
}

/**
 * Create a reporter bound to a directory, endpoint, and optional identity.
 *
 * The returned object is stateless; each `prepare` call collects fresh local
 * context, and each `submit` serializes a new payload.
 */
export function createBugReporter(options: BugReporterOptions = {}): BugReporter {
  const cwd = options.cwd ?? process.cwd();
  const configDir = resolveReportConfigDir(options.configDir);
  const endpoint = resolveReportEndpoint(options.endpoint);
  const now = options.now ?? (() => new Date());

  async function prepare(draft: BugReportDraft): Promise<PreparedReport> {
    const title = draft.title?.trim();
    if (!title) {
      throw new Error("A bug report needs a non-empty title");
    }
    const collected = await collectDiagnostics({
      cliVersion: options.cliVersion,
      installKind: options.installKind,
      cwd,
      configDir,
      signedIn: options.signedIn ?? false,
      diagnostics: draft.diagnostics,
      logs: draft.logs,
      logPaths: draft.logPaths,
      runId: draft.runId,
      taskKey: draft.taskKey,
      last: draft.last,
      shareIdentifiers: draft.shareIdentifiers,
      command: draft.command,
    });
    const redaction = redactionFor(draft, collected, cwd);
    const contactEmail = (draft.contactEmail ?? options.contactEmail)?.trim();
    const signedIn = options.signedIn ?? false;
    const context = collected.context ? { ...collected.context } : undefined;
    const evidence = prepareEvidence(draft.evidence, redaction);
    if (context && evidence) context.evidence = evidence;
    const logs: ReportLogAttachment[] | undefined = context?.logs?.map((log) => ({
      ...log,
      text: redactReportText(log.text, { ...redaction, maxChars: 64 * 1024 }),
    }));
    if (context && logs) context.logs = logs;

    const payload: BugReportPayload = {
      schema: 1,
      reportId: randomUUID(),
      createdAt: now().toISOString(),
      source: draft.source ?? "cli",
      title: redactReportText(title, { ...redaction, maxChars: MAX_TITLE_CHARS }),
      description: redactReportText(draft.description ?? "", {
        ...redaction,
        maxChars: MAX_DESCRIPTION_CHARS,
      }),
      ...(contactEmail || signedIn
        ? {
            contact: {
              ...(contactEmail ? { email: contactEmail } : {}),
              signedIn,
            },
          }
        : {}),
      environment: collected.environment,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
      fingerprint: buildFingerprint({
        title,
        failedStep: context?.run?.failedStep,
        reason: context?.run?.reason,
      }),
      userAgent: `devintern/${options.cliVersion ?? "unknown"} (+report)`,
    };

    fitPayload(payload);
    return {
      payload,
      bytes: Buffer.byteLength(serializePayload(payload), "utf8"),
    };
  }

  async function submitPrepared(prepared: PreparedReport): Promise<SubmittedReport> {
    if (prepared.bytes > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `Report payload exceeds the ${Math.floor(MAX_PAYLOAD_BYTES / 1024)} KB limit.`,
      );
    }
    return postReport({
      endpoint,
      payload: prepared.payload,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  return {
    prepare,
    async submit(draft) {
      return submitPrepared(await prepare(draft));
    },
    submitPrepared,
  };
}

/**
 * Collect a local run summary and log tails for plugins that want to attach
 * their own evidence without submitting.
 */
export async function collectRunDiagnostics(
  input: {
    runId?: number;
    taskKey?: string;
    last?: boolean;
    cwd?: string;
    shareIdentifiers?: boolean;
    logs?: boolean;
    logPaths?: string[];
  } = {},
): Promise<RunDiagnostics> {
  const collected = await collectDiagnostics({
    cwd: input.cwd,
    diagnostics: true,
    logs: input.logs ?? true,
    logPaths: input.logPaths,
    runId: input.runId,
    taskKey: input.taskKey,
    last: input.last,
    shareIdentifiers: input.shareIdentifiers,
  });
  return {
    run: collected.context?.run ?? null,
    logs: collected.context?.logs ?? [],
  };
}

export { buildFingerprint } from "./fingerprint";
export { redactReportText } from "./redact";
export { readStoredIdentity } from "./session";
export { DEFAULT_REPORT_ENDPOINT, ReportSubmitError } from "./client";
export { isBugReportPayload, isSpoolEntry, readSpoolFile } from "./store";
export type {
  BugReportDraft,
  BugReportPayload,
  BugReporter,
  BugReporterOptions,
  PreparedReport,
  ReportContext,
  ReportEnvironment,
  ReportEvidence,
  ReportLogAttachment,
  ReportRunSummary,
  ReportSource,
  RunDiagnostics,
  SubmittedReport,
} from "./types";
