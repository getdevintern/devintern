/**
 * Links from the dashboard to the public DevIntern repository's issue forms
 * and the product docs.
 *
 * Issue forms (`.github/ISSUE_TEMPLATE/*.yml`) prefill a field from a query
 * parameter named after its `id`, so the version field arrives filled in.
 * Nothing else from this machine goes into the URL.
 */

export const ISSUES_URL = "https://github.com/getdevintern/devintern/issues";
export const DOCS_URL = "https://devintern.com/docs/code";

export type IssueTemplate = "feature_request.yml" | "bug_report.yml";

/** A new-issue URL for a template, with the version field prefilled when known. */
export function newIssueUrl(template: IssueTemplate, version?: string | null): string {
  const params = new URLSearchParams({ template });
  const trimmed = version?.trim();
  if (trimmed) params.set("version", trimmed);
  return `${ISSUES_URL}/new?${params.toString()}`;
}

/** The running CLI version from a `GET /api/health` body, or null. */
export function parseHealthVersion(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("version" in body)) return null;
  const { version } = body as { version: unknown };
  return typeof version === "string" && version.trim() ? version.trim() : null;
}
