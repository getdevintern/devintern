/**
 * Minimal Sentry API client for the error-watching acquirer.
 *
 * Reads unresolved issues from either the project-scoped endpoint (when a
 * project slug is configured) or the organization-wide endpoint. Works with
 * sentry.io and self-hosted Sentry (SENTRY_BASE_URL).
 */

import type { ErrorMonitorIssue, ErrorMonitorProvider, IssueValidity } from "./error-monitor";

export const DEFAULT_SENTRY_BASE_URL = "https://sentry.io";

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

    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Sentry rejected the auth token (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Sentry API error (HTTP ${response.status}) for ${url}`);
    }

    const body = (await response.json()) as Array<Record<string, unknown>>;
    return body.map((raw) => {
      const id = String(raw.id);
      const shortId = String(raw.shortId ?? raw.id);
      const count = String(raw.count ?? "0");
      return {
        externalId: `issue:${id}`,
        displayId: shortId,
        occurrenceCount: Number(count),
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
    const lines = [
      `# Fix Sentry error ${issue.shortId}`,
      "",
      "## Error",
      "",
      `- **Title**: ${issue.title}`,
      `- **Sentry ID**: ${issue.shortId} (${issue.id})`,
      `- **Level**: ${issue.level ?? "error"}`,
      `- **Events**: ${issue.count}`,
      `- **First seen**: ${issue.firstSeen}`,
      `- **Last seen**: ${issue.lastSeen}`,
      `- **Link**: ${issue.permalink}`,
    ];
    if (issue.culprit) lines.push(`- **Culprit**: ${issue.culprit}`);
    if (issue.metadata?.type) lines.push(`- **Exception type**: ${issue.metadata.type}`);
    if (issue.metadata?.value) lines.push(`- **Exception message**: ${issue.metadata.value}`);
    if (issue.metadata?.filename) lines.push(`- **File**: ${issue.metadata.filename}`);
    lines.push(
      "",
      "## Task",
      "",
      "Reproduce the root cause of this error from the details above, implement the",
      "minimal fix in this repository, and add or adjust tests covering the failure",
      "path. Do not change unrelated behavior.",
      "",
    );
    return lines.join("\n");
  }
}
