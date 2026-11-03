/**
 * Minimal Sentry API client for the error-watching acquirer.
 *
 * Reads unresolved issues from either the project-scoped endpoint (when a
 * project slug is configured) or the organization-wide endpoint. Works with
 * sentry.io and self-hosted Sentry (SENTRY_BASE_URL).
 */

import type {
  ErrorMonitorIssue,
  ErrorMonitorProvider,
  IssueValidity,
} from "../acquirers/error-monitor";
import { SourceFetchError } from "../acquirers/source-fetch";
import { untrustedContentBlock } from "../prompts/untrusted-content";

export const DEFAULT_SENTRY_BASE_URL = "https://sentry.io";
export const SENTRY_ACTION_SUCCEEDED_COMMENT =
  "🤖 DevIntern completed an automated remediation run for this issue. " +
  "The issue remains unresolved pending deployment and verification.";
export const SENTRY_ACTION_FAILED_COMMENT =
  "🤖 DevIntern attempted automated remediation, but the run did not complete successfully. " +
  "The issue remains unresolved.";

/** Extra attempts after the first for transient network/5xx failures. */
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
/**
 * Hard cap on a single HTTP request. A peer that accepts the connection but
 * never sends a response would otherwise leave the request, and with it the
 * whole poll tick, pending forever.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Hard cap on the wall-clock time of one fetch, requests plus retry sleeps.
 * The sleep budget alone cannot bound a read because a single attempt can
 * consume an arbitrary amount of time before the response headers arrive.
 */
const MAX_TOTAL_FETCH_DURATION_MS = 15_000;
/**
 * Total time one fetch may spend sleeping between retries. The budget covers
 * the whole retry loop, not each sleep, so an upstream outage carrying a long
 * Retry-After cannot stall polling or delay worker startup. A server hint that
 * does not fit the remaining budget ends retries instead of being shortened,
 * because sending the next request before the hint expires would prolong
 * throttling.
 */
export const MAX_TOTAL_RETRY_WAIT_MS = 4_000;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a fetch rejection was caused by our own abort timeout. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Render a failed attempt, naming a timeout instead of a bare abort. */
function describeRequestFailure(error: unknown, url: string, timeoutMs: number): string {
  if (isTimeoutError(error)) {
    return `Sentry request timed out after ${timeoutMs}ms for ${url}`;
  }
  return `Sentry request failed for ${url}: ${(error as Error).message}`;
}

/** Exponential backoff with jitter, or the exact server hint when present. */
function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const ceiling = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return ceiling + Math.random() * ceiling * 0.5;
}

/**
 * Split a Sentry search query on whitespace while keeping quoted phrases
 * intact, so terms like `message:"foo is:unresolved bar"` stay one term.
 * Quoted substrings are preserved verbatim, including internal whitespace.
 */
function splitQueryTerms(query: string): string[] {
  const terms: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;
  for (const char of query) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        terms.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) terms.push(current);
  return terms;
}

/** Compose Sentry search terms so `is:unresolved` appears exactly once. */
function composeUnresolvedQuery(extra?: string): string {
  const composed: string[] = [];
  let sawUnresolved = false;
  for (const term of splitQueryTerms(extra ?? "")) {
    // Only an unquoted standalone term is the resolved/unresolved filter; the
    // same text inside a quoted phrase is part of a message search.
    if (!term.includes('"') && /^is:unresolved$/i.test(term)) {
      if (sawUnresolved) continue;
      sawUnresolved = true;
      composed.push("is:unresolved");
    } else {
      composed.push(term);
    }
  }
  if (!sawUnresolved) composed.unshift("is:unresolved");
  return composed.join(" ");
}

/** Subset of the Sentry issue (group) payload the acquirer needs. */
export interface SentryIssue extends ErrorMonitorIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  level: string | null;
  status: string;
  /** Total event count as reported by Sentry (string in the API). */
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  metadata?: {
    type?: string;
    value?: string;
    filename?: string;
    function?: string;
  };
}

export interface SentryClientOptions {
  authToken: string;
  organization: string;
  /** Project slug; when set, queries are scoped to this project. */
  project?: string;
  baseUrl?: string;
  query?: string;
  fetchImpl?: typeof fetch;
  /** Extra attempts after the first for transient failures (default 2). */
  maxRetries?: number;
  /** Hard per-request timeout in milliseconds (default 10s). */
  requestTimeoutMs?: number;
  /** Hard wall-clock cap for one fetch including retries (default 15s). */
  maxTotalDurationMs?: number;
  /** Sleep override so tests can avoid real backoff waits. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class SentryClient implements ErrorMonitorProvider<SentryIssue> {
  readonly providerName = "sentry";
  private readonly authToken: string;
  readonly organization: string;
  readonly project?: string;
  private readonly baseUrl: string;
  private readonly query?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly maxTotalDurationMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: SentryClientOptions) {
    this.authToken = options.authToken;
    this.organization = options.organization;
    this.project = options.project;
    this.baseUrl = (options.baseUrl || DEFAULT_SENTRY_BASE_URL).replace(/\/+$/, "");
    this.query = options.query;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES);
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxTotalDurationMs = Math.max(
      1,
      options.maxTotalDurationMs ?? MAX_TOTAL_FETCH_DURATION_MS,
    );
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  /**
   * Fetch unresolved issues, newest activity first.
   *
   * @param query - Extra Sentry search query terms (ANDed with `is:unresolved`)
   * @returns Parsed issue list
   */
  async fetchUnresolvedIssues(query = this.query): Promise<SentryIssue[]> {
    const params = new URLSearchParams({
      query: composeUnresolvedQuery(query),
      sort: "date",
      statsPeriod: "14d",
      per_page: "100",
    });
    const path = this.project
      ? `/api/0/projects/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/issues/`
      : `/api/0/organizations/${encodeURIComponent(this.organization)}/issues/`;
    const url = `${this.baseUrl}${path}?${params.toString()}`;

    const response = await this.requestWithRetry(url);

    let body: Array<Record<string, unknown>>;
    try {
      body = (await response.json()) as Array<Record<string, unknown>>;
    } catch (error) {
      throw new SourceFetchError(
        "unreadable",
        `Sentry returned an unreadable response for ${url}: ${(error as Error).message}`,
      );
    }
    return body.map((raw) => {
      const id = String(raw.id);
      const shortId = String(raw.shortId ?? raw.id);
      const count = String(raw.count ?? "0");
      const rawProject = raw.project as { slug?: unknown } | undefined;
      return {
        externalId: `issue:${id}`,
        displayId: shortId,
        occurrenceCount: Number(count),
        projectSlug: typeof rawProject?.slug === "string" ? rawProject.slug : this.project,
        id,
        shortId,
        title: String(raw.title ?? ""),
        culprit: typeof raw.culprit === "string" ? raw.culprit : null,
        level: typeof raw.level === "string" ? raw.level : null,
        status: String(raw.status ?? ""),
        count,
        firstSeen: String(raw.firstSeen ?? ""),
        lastSeen: String(raw.lastSeen ?? ""),
        permalink: String(raw.permalink ?? ""),
        metadata: (raw.metadata as SentryIssue["metadata"]) ?? undefined,
      };
    });
  }

  /**
   * Send the issue request, retrying transient network/5xx failures a bounded
   * number of times inside a single overall wait budget. Auth and rate-limit
   * responses are classified immediately so the acquirer can keep its durable
   * backoff behavior.
   *
   * Every attempt carries an abort timeout and the loop also has a wall-clock
   * deadline, so a peer that accepts the connection and never responds cannot
   * leave the tick (and the acquirer's `busy` flag) pending forever.
   */
  private async requestWithRetry(url: string): Promise<Response> {
    const deadline = Date.now() + this.maxTotalDurationMs;
    let spentWaitMs = 0;
    /**
     * Reserve the next sleep from the leftover budget. `undefined` means the
     * budget is gone and retrying would only delay the failure. A server hint
     * (`mustHonor`) that is longer than the remaining budget also returns
     * `undefined`: sleeping only part of it would retry too early.
     */
    const takeWaitBudget = (candidate: number, mustHonor = false): number | undefined => {
      const remaining = Math.min(MAX_TOTAL_RETRY_WAIT_MS - spentWaitMs, deadline - Date.now());
      if (remaining <= 0) return undefined;
      if (mustHonor && candidate > remaining) return undefined;
      const wait = Math.min(candidate, remaining);
      spentWaitMs += wait;
      return wait;
    };

    for (let attempt = 0; ; attempt++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new SourceFetchError(
          "unreadable",
          `Sentry request timed out after ${this.maxTotalDurationMs}ms for ${url}`,
        );
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${this.authToken}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, remainingMs)),
        });
      } catch (error) {
        const wait = attempt >= this.maxRetries ? undefined : takeWaitBudget(retryDelayMs(attempt));
        if (wait === undefined) {
          throw new SourceFetchError(
            "unreadable",
            describeRequestFailure(error, url, this.requestTimeoutMs),
          );
        }
        await this.sleepImpl(wait);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new SourceFetchError(
          "auth-failed",
          `Sentry rejected the auth token (HTTP ${response.status})`,
        );
      }
      if (response.status === 429) {
        throw new SourceFetchError(
          "rate-limited",
          `Sentry rate-limited the request (HTTP 429) for ${url}`,
          { retryAfterMs: parseRetryAfterMs(response) },
        );
      }
      if (response.status >= 500 && response.status <= 599) {
        const retryAfterMs = parseRetryAfterMs(response);
        const wait =
          attempt >= this.maxRetries
            ? undefined
            : takeWaitBudget(retryDelayMs(attempt, retryAfterMs), retryAfterMs !== undefined);
        if (wait === undefined) {
          throw new SourceFetchError(
            "unreadable",
            `Sentry API error (HTTP ${response.status}) for ${url}`,
          );
        }
        await this.sleepImpl(wait);
        continue;
      }
      if (!response.ok) {
        throw new SourceFetchError(
          "unreadable",
          `Sentry API error (HTTP ${response.status}) for ${url}`,
        );
      }
      return response;
    }
  }

  /** Shared-provider adapter entry point. */
  fetchIssues(): Promise<SentryIssue[]> {
    return this.fetchUnresolvedIssues();
  }

  /** Leave best-effort human-visible feedback without changing issue status. */
  async reportAction(issue: SentryIssue, succeeded: boolean): Promise<void> {
    const url =
      `${this.baseUrl}/api/0/organizations/${encodeURIComponent(this.organization)}` +
      `/issues/${encodeURIComponent(issue.id)}/comments/`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: succeeded ? SENTRY_ACTION_SUCCEEDED_COMMENT : SENTRY_ACTION_FAILED_COMMENT,
        }),
        // The comment is posted from inside a poll tick, so it needs the same
        // bound as a read: a hung comment must not keep the tick busy forever.
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Sentry comment request timed out after ${this.requestTimeoutMs}ms for ${url}`,
        );
      }
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Sentry rejected issue-comment access (HTTP ${response.status}); ` +
          "use a user-authenticated token with Issue & Event write access",
      );
    }
    if (!response.ok) {
      throw new Error(`Sentry comment API error (HTTP ${response.status}) for ${url}`);
    }
  }

  /** Sentry-specific actionability check after the shared occurrence gate. */
  validateIssue(issue: SentryIssue): IssueValidity {
    if (!issue.title.trim()) return { valid: false, reason: "missing error title" };
    if (!issue.culprit && !issue.metadata?.type && !issue.metadata?.filename) {
      return { valid: false, reason: "no culprit or exception metadata to locate the error" };
    }
    return { valid: true };
  }

  /** Render a Sentry issue as a local markdown task for the normal pipeline. */
  buildTaskMarkdown(issue: SentryIssue): string {
    const errorLines = [
      `- **Title**: ${issue.title}`,
      `- **Sentry ID**: ${issue.shortId} (${issue.id})`,
      `- **Level**: ${issue.level ?? "error"}`,
      `- **Events**: ${issue.count}`,
      `- **First seen**: ${issue.firstSeen}`,
      `- **Last seen**: ${issue.lastSeen}`,
      `- **Link**: ${issue.permalink}`,
    ];
    if (issue.culprit) errorLines.push(`- **Culprit**: ${issue.culprit}`);
    if (issue.metadata?.type) errorLines.push(`- **Exception type**: ${issue.metadata.type}`);
    if (issue.metadata?.value) errorLines.push(`- **Exception message**: ${issue.metadata.value}`);
    if (issue.metadata?.filename) errorLines.push(`- **File**: ${issue.metadata.filename}`);
    return [
      "# Fix Sentry error",
      "",
      "## Error",
      "",
      untrustedContentBlock(errorLines.join("\n"), "sentry issue"),
      "",
      "## Task",
      "",
      "Reproduce the root cause of this error from the details above, implement the",
      "minimal fix in this repository, and add or adjust tests covering the failure",
      "path. Do not change unrelated behavior.",
      "",
    ].join("\n");
  }
}

/** Interpret a `Retry-After` header as milliseconds, when the server sent one. */
function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}
