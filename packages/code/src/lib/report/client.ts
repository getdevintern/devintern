/**
 * HTTP client for the DevIntern report endpoint.
 *
 * The endpoint is intentionally boring: one JSON POST, bounded by a timeout,
 * with the Supabase access token forwarded when the caller is signed in.
 */

import type { BugReportPayload, SubmittedReport } from "./types";

/** Default submission endpoint; override with `DEVINTERN_REPORT_URL`. */
export const DEFAULT_REPORT_ENDPOINT = "https://devintern.com/api/reports";

/** Submission failure with the server's status and message when available. */
export class ReportSubmitError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ReportSubmitError";
    this.status = status;
  }
}

export interface PostReportOptions {
  endpoint: string;
  payload: BugReportPayload;
  accessToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ReportResponseBody {
  id?: unknown;
  url?: unknown;
  receipt?: unknown;
  error?: unknown;
}

/** Read the response body without letting malformed JSON mask the status. */
async function readBody(response: Response): Promise<ReportResponseBody> {
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object") {
      return parsed as ReportResponseBody;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * POST a prepared payload and return the server's receipt.
 *
 * @throws {ReportSubmitError} when the endpoint rejects the report or the
 *         request cannot be completed.
 */
export async function postReport(options: PostReportOptions): Promise<SubmittedReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `devintern/${options.payload.environment.cliVersion} (+report)`,
  };
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(options.payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReportSubmitError(`Could not reach ${options.endpoint}: ${message}`);
  }

  const body = await readBody(response);
  if (!response.ok) {
    const serverMessage =
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : response.statusText || "request failed";
    throw new ReportSubmitError(
      `Report endpoint rejected the report (${response.status}): ${serverMessage}`,
      response.status,
    );
  }

  const id =
    typeof body.id === "string" && body.id.trim() ? body.id.trim() : options.payload.reportId;
  return {
    id,
    ...(typeof body.url === "string" && body.url.trim() ? { url: body.url.trim() } : {}),
    ...(typeof body.receipt === "string" && body.receipt.trim()
      ? { receipt: body.receipt.trim() }
      : {}),
  };
}
