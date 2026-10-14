/**
 * Acknowledgement classification for webhook delivery failures.
 *
 * A webhook relay must distinguish two failures that look identical to a
 * generic `catch`:
 *
 * - **permanent** — the referenced resource is gone or forbidden (an HTTP 4xx
 *   such as 404/403). Retrying can never succeed, so the delivery is
 *   acknowledged and recorded instead of being redelivered forever.
 * - **transient** — the platform or network is momentarily unavailable (an
 *   HTTP 429/5xx, a timeout, a connection failure). The delivery must *not* be
 *   acknowledged so the platform retries it later.
 *
 * Anything unrecognized defaults to `transient`: losing an event is worse than
 * retrying one. Handlers that know a failure is terminal can throw
 * {@link PermanentWebhookError} to say so explicitly.
 */

/** How a webhook delivery failure should be acknowledged. */
export type WebhookFailureClass = "permanent" | "transient";

export interface PermanentWebhookErrorOptions {
  /** HTTP status that made the failure terminal (e.g. `404`). */
  status?: number;
}

/**
 * A webhook handler failure that will never succeed on retry.
 *
 * Throwing this (or an error carrying a permanent HTTP status) tells the
 * delivery layer to acknowledge and record the event rather than leave it
 * outstanding for the platform to redeliver.
 */
export class PermanentWebhookError extends Error {
  readonly status?: number;

  constructor(message: string, options: PermanentWebhookErrorOptions = {}) {
    super(message);
    this.name = "PermanentWebhookError";
    this.status = options.status;
  }
}

/** HTTP statuses that indicate the request can never succeed as-is. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 410, 422]);

/**
 * Read an HTTP status from an error's properties or its message. GitHub API
 * errors embed the status as `GitHub API error (404): …`; transport clients
 * often attach `status` / `statusCode` / `response.status`.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const record = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    for (const candidate of [record.status, record.statusCode, record.response?.status]) {
      if (typeof candidate === "number" && Number.isInteger(candidate)) {
        return candidate;
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\((\d{3})\)/) ?? message.match(/\bHTTP (\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Classify a webhook handler failure as permanent (acknowledge and record) or
 * transient (leave unacknowledged so the platform retries).
 *
 * @param error - Error thrown by a delivery handler
 */
export function classifyWebhookError(error: unknown): WebhookFailureClass {
  if (error instanceof PermanentWebhookError) {
    return "permanent";
  }
  const status = httpStatusOf(error);
  if (status !== undefined) {
    return PERMANENT_STATUSES.has(status) ? "permanent" : "transient";
  }
  return "transient";
}
