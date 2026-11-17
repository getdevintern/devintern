/**
 * Dashboard bug reports: the dashboard's equivalent of `devintern report --run <id>`.
 *
 * The flow is two-step so the consent preview stays binding:
 *
 * 1. `POST /api/runs/:id/report/preview` collects and redacts the bundle for
 *    that run (the same collection as the CLI), stores the prepared payload
 *    in memory under a random preview id, and returns it for review.
 * 2. `POST /api/reports` submits exactly the stored payload. The only field the
 *    send step may add is the anonymous contact email the user typed there.
 *
 * Submission spools the payload locally first, like the CLI, so a failed send
 * leaves a copy for `devintern report --from <path>`.
 */

import { randomUUID } from "node:crypto";

import { VERSION } from "../cli/bootstrap";
import { resolveRuntimeStateDir } from "../config/config-dir";
import { createBugReporter, resolveReportEndpoint, serializePayload } from "../report/api";
import { resolveIdentity } from "../report/identity";
import { resolveReportDir } from "../report/paths";
import { summarizeReportPayload } from "../report/preview";
import type { ReportPreviewSummary } from "../report/preview";
import type { ReportIdentity } from "../report/session";
import { pruneSpool } from "../report/store";
import { currentInstallKind, isValidContactEmail, submitWithSpool } from "../report/submission";
import type { BugReporter, BugReportPayload, PreparedReport } from "../report/types";
import type { ApiResponse, DashboardData } from "./dashboard-api";

/** How long a preview stays submittable. */
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
/** Previews held at once; the oldest is evicted beyond this. */
const MAX_PREVIEWS = 20;
/** Raw input caps; the payload builder applies the tighter wire caps. */
const MAX_TITLE_INPUT = 1000;
const MAX_DESCRIPTION_INPUT = 50_000;

/** Validated `POST /api/runs/:id/report/preview` body. */
export interface ReportPreviewRequest {
  title: string;
  description: string;
  shareIdentifiers: boolean;
}

/** Validated `POST /api/reports` body. */
export interface ReportSubmitRequest {
  previewId: string;
  email?: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a preview request body. */
export function parseReportPreviewRequest(value: unknown): Parsed<ReportPreviewRequest> {
  const record = asRecord(value);
  if (!record) return { ok: false, error: "request body must be a JSON object" };
  const { title, description, shareIdentifiers } = record;
  if (typeof title !== "string" || !title.trim()) {
    return { ok: false, error: "title is required" };
  }
  if (title.length > MAX_TITLE_INPUT) {
    return { ok: false, error: `title must be at most ${MAX_TITLE_INPUT} characters` };
  }
  if (typeof description !== "string" || !description.trim()) {
    return { ok: false, error: "description is required" };
  }
  if (description.length > MAX_DESCRIPTION_INPUT) {
    return {
      ok: false,
      error: `description must be at most ${MAX_DESCRIPTION_INPUT} characters`,
    };
  }
  if (shareIdentifiers !== undefined && typeof shareIdentifiers !== "boolean") {
    return { ok: false, error: "shareIdentifiers must be a boolean" };
  }
  return {
    ok: true,
    value: {
      title: title.trim(),
      description: description.trim(),
      shareIdentifiers: shareIdentifiers === true,
    },
  };
}

/** Parse a submit request body. */
export function parseReportSubmitRequest(value: unknown): Parsed<ReportSubmitRequest> {
  const record = asRecord(value);
  if (!record) return { ok: false, error: "request body must be a JSON object" };
  const { previewId, email } = record;
  if (typeof previewId !== "string" || !previewId.trim()) {
    return { ok: false, error: "previewId is required" };
  }
  if (email !== undefined && email !== null && typeof email !== "string") {
    return { ok: false, error: "email must be a string" };
  }
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  return {
    ok: true,
    value: {
      previewId: previewId.trim(),
      ...(trimmedEmail ? { email: trimmedEmail } : {}),
    },
  };
}

/** Injectable collaborators (tests stub identity and the network). */
export interface DashboardReportDeps {
  /** Resolve the reporter identity (default: refresh the stored session). */
  resolveIdentity?: (configDir: string) => Promise<ReportIdentity>;
  /** Transport for the report endpoint (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Config dir holding the session and `reports/` spool (default: runtime state dir). */
  configDir?: string;
  /** Report endpoint override (default: `DEVINTERN_REPORT_URL` or devintern.com). */
  endpoint?: string;
  /** Clock for preview expiry. */
  now?: () => number;
  /** Preview lifetime. */
  previewTtlMs?: number;
  /** Version reported in the environment block. */
  cliVersion?: string;
}

interface StoredPreview {
  runId: number;
  prepared: PreparedReport;
  reporter: BugReporter;
  signedIn: boolean;
  expiresAt: number;
  submitting: boolean;
}

/** Preview response: what will be sent, and the payload itself. */
export interface ReportPreviewResponse {
  previewId: string;
  expiresAt: number;
  runId: number;
  signedIn: boolean;
  /** Anonymous reports need a contact email on submit. */
  contactRequired: boolean;
  destination: string;
  title: string;
  description: string;
  bytes: number;
  attachments: Omit<ReportPreviewSummary, "omitted">;
  omitted: string[];
  payload: BugReportPayload;
}

function badRequest(error: string): ApiResponse {
  return { status: 400, body: { error } };
}

/**
 * Report previews and submissions for one dashboard server.
 *
 * Previews live in memory only: they hold the access token the submission
 * will use and are never written to disk until the user presses Send.
 */
export class DashboardReports {
  private readonly previews = new Map<string, StoredPreview>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly data: DashboardData,
    private readonly deps: DashboardReportDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
  }

  private get configDir(): string {
    return this.deps.configDir ?? resolveRuntimeStateDir(this.data.workingDir);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
    while (this.previews.size > MAX_PREVIEWS) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
  }

  /** `POST /api/runs/:id/report/preview`. */
  async preview(idParam: string, body: unknown): Promise<ApiResponse> {
    const runId = Number.parseInt(idParam, 10);
    if (!Number.isFinite(runId) || runId <= 0 || String(runId) !== idParam) {
      return badRequest("run id must be a positive integer");
    }
    const parsed = parseReportPreviewRequest(body);
    if (!parsed.ok) return badRequest(parsed.error);
    if (!this.data.getRunDetail(runId)) {
      return { status: 404, body: { error: `run ${runId} not found` } };
    }

    const configDir = this.configDir;
    const identity = await (this.deps.resolveIdentity ?? resolveIdentity)(configDir);
    const reporter = createBugReporter({
      accessToken: identity.accessToken,
      signedIn: identity.signedIn,
      cliVersion: this.deps.cliVersion ?? VERSION,
      installKind: currentInstallKind(),
      cwd: this.data.workingDir,
      configDir,
      runDbPath: this.data.dbPath,
      workerLogDirs: [this.data.workspaceDir],
      ...(this.deps.endpoint ? { endpoint: this.deps.endpoint } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });

    let prepared: PreparedReport;
    try {
      prepared = await reporter.prepare({
        title: parsed.value.title,
        description: parsed.value.description,
        source: "cli",
        runId,
        diagnostics: true,
        logs: true,
        shareIdentifiers: parsed.value.shareIdentifiers,
      });
    } catch (error) {
      return {
        status: 422,
        body: { error: `Could not prepare the report: ${(error as Error).message}` },
      };
    }

    const previewId = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.previews.set(previewId, {
      runId,
      prepared,
      reporter,
      signedIn: identity.signedIn,
      expiresAt,
      submitting: false,
    });
    this.prune();

    const { omitted, ...attachments } = summarizeReportPayload(prepared.payload, {
      shareIdentifiers: parsed.value.shareIdentifiers,
    });
    const response: ReportPreviewResponse = {
      previewId,
      expiresAt,
      runId,
      signedIn: identity.signedIn,
      contactRequired: !identity.signedIn,
      destination: resolveReportEndpoint(this.deps.endpoint),
      title: prepared.payload.title,
      description: prepared.payload.description,
      bytes: prepared.bytes,
      attachments,
      omitted,
      payload: prepared.payload,
    };
    return { status: 200, body: response };
  }

  /** `POST /api/reports`. */
  async submit(body: unknown): Promise<ApiResponse> {
    const parsed = parseReportSubmitRequest(body);
    if (!parsed.ok) return badRequest(parsed.error);
    this.prune();
    const stored = this.previews.get(parsed.value.previewId);
    if (!stored) {
      return {
        status: 404,
        body: { error: "This preview expired or does not exist. Preview the report again." },
      };
    }
    if (stored.submitting) {
      return { status: 409, body: { error: "This report is already being sent." } };
    }

    const email = parsed.value.email;
    if (!stored.signedIn && !isValidContactEmail(email)) {
      return badRequest(
        "Anonymous reports need a valid contact email. Enter one or run `devintern login`.",
      );
    }

    // Anonymous reports carry the contact typed on the send step; everything
    // else is the previewed payload, unchanged.
    let prepared = stored.prepared;
    if (!stored.signedIn && email) {
      const payload: BugReportPayload = {
        ...prepared.payload,
        contact: { email, signedIn: false },
      };
      prepared = { payload, bytes: Buffer.byteLength(serializePayload(payload), "utf8") };
    }

    const reportDir = resolveReportDir(this.configDir);
    pruneSpool(reportDir);
    stored.submitting = true;
    try {
      const outcome = await submitWithSpool(stored.reporter, prepared, reportDir);
      if (outcome.ok) {
        this.previews.delete(parsed.value.previewId);
        const { result } = outcome;
        return {
          status: 200,
          body: {
            status: "sent",
            reportId: result.id,
            shortId: result.id.slice(0, 8),
            ...(result.url ? { url: result.url } : {}),
            ...(result.receipt ? { receipt: result.receipt } : {}),
            savedPath: outcome.savedPath,
          },
        };
      }
      // Keep the preview so the user can try again from the dialog.
      return {
        status: 502,
        body: {
          status: "saved",
          error: outcome.error,
          authExpired: outcome.authExpired,
          savedPath: outcome.savedPath,
          retryCommand: `devintern report --from ${outcome.savedPath}`,
        },
      };
    } finally {
      stored.submitting = false;
    }
  }
}
