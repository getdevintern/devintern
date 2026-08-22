/**
 * Minimal Sentry API client for the error-watching acquirer.
 *
 * Reads unresolved issues from either the project-scoped endpoint (when a
 * project slug is configured) or the organization-wide endpoint. Works with
 * sentry.io and self-hosted Sentry (SENTRY_BASE_URL).
 */

export const DEFAULT_SENTRY_BASE_URL = "https://sentry.io";

/** Subset of the Sentry issue (group) payload the acquirer needs. */
export interface SentryIssue {
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
  fetchImpl?: typeof fetch;
}

export class SentryClient {
  private readonly authToken: string;
  readonly organization: string;
  readonly project?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SentryClientOptions) {
    this.authToken = options.authToken;
    this.organization = options.organization;
    this.project = options.project;
    this.baseUrl = (options.baseUrl || DEFAULT_SENTRY_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch unresolved issues, newest activity first.
   *
   * @param query - Extra Sentry search query terms (ANDed with `is:unresolved`)
   * @returns Parsed issue list
   */
  async fetchUnresolvedIssues(query?: string): Promise<SentryIssue[]> {
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
    return body.map((raw) => ({
      id: String(raw.id),
      shortId: String(raw.shortId ?? raw.id),
      title: String(raw.title ?? ""),
      culprit: typeof raw.culprit === "string" ? raw.culprit : null,
      level: typeof raw.level === "string" ? raw.level : null,
      status: String(raw.status ?? ""),
      count: String(raw.count ?? "0"),
      firstSeen: String(raw.firstSeen ?? ""),
      lastSeen: String(raw.lastSeen ?? ""),
      permalink: String(raw.permalink ?? ""),
      metadata: (raw.metadata as SentryIssue["metadata"]) ?? undefined,
    }));
  }
}
