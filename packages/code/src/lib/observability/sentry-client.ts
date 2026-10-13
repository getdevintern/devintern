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
}

export class SentryClient implements ErrorMonitorProvider<SentryIssue> {
  readonly providerName = "sentry";
  private readonly authToken: string;
  readonly organization: string;
  readonly project?: string;
  private readonly baseUrl: string;
  private readonly query?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SentryClientOptions) {
    this.authToken = options.authToken;
    this.organization = options.organization;
    this.project = options.project;
    this.baseUrl = (options.baseUrl || DEFAULT_SENTRY_BASE_URL).replace(/\/+$/, "");
    this.query = options.query;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch unresolved issues, newest activity first.
   *
   * @param query - Extra Sentry search query terms (ANDed with `is:unresolved`)
   * @returns Parsed issue list
   */
  async fetchUnresolvedIssues(query = this.query): Promise<SentryIssue[]> {
    const params = new URLSearchParams({
      query: query ? `is:unresolved ${query}`.trim() : "is:unresolved",
      sort: "date",
      statsPeriod: "14d",
      per_page: "100",
    });
    const path = this.project
      ? `/api/0/projects/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/issues/`
      : `/api/0/organizations/${encodeURIComponent(this.organization)}/issues/`;
    const url = `${this.baseUrl}${path}?${params.toString()}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      throw new SourceFetchError(
        "unreadable",
        `Sentry request failed for ${url}: ${(error as Error).message}`,
      );
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
    if (!response.ok) {
      throw new SourceFetchError(
        "unreadable",
        `Sentry API error (HTTP ${response.status}) for ${url}`,
      );
    }

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

  /** Shared-provider adapter entry point. */
  fetchIssues(): Promise<SentryIssue[]> {
    return this.fetchUnresolvedIssues();
  }

  /** Leave best-effort human-visible feedback without changing issue status. */
  async reportAction(issue: SentryIssue, succeeded: boolean): Promise<void> {
    const url =
      `${this.baseUrl}/api/0/organizations/${encodeURIComponent(this.organization)}` +
      `/issues/${encodeURIComponent(issue.id)}/comments/`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: succeeded ? SENTRY_ACTION_SUCCEEDED_COMMENT : SENTRY_ACTION_FAILED_COMMENT,
      }),
    });

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
      `# Fix Sentry error ${issue.shortId}`,
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
