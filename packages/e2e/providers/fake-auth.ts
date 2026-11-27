/**
 * Credential and query-rejection helpers shared by the tracker fakes: the
 * HTTP bodies each provider answers with when a caller-chosen secret does not
 * match, or when the provider rejects a search query.
 */

/** Substring rules a fake checks a search query against before answering it. */
export class SearchRejections {
  private readonly rules: Array<{ needle: string; message: string }> = [];

  add(needle: string, message: string): void {
    this.rules.push({ needle, message });
  }

  /** The message of the first rule whose needle occurs in `query`, if any. */
  find(query: string): string | undefined {
    return this.rules.find(({ needle }) => query.includes(needle))?.message;
  }
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Plain-text response, the shape Trello uses for 400 and 401 errors. */
export function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Linear's answer to a missing or unknown API key. */
export function linearAuthenticationError(): Response {
  const extensions = {
    type: "authentication error",
    code: "AUTHENTICATION_ERROR",
    statusCode: 401,
    userPresentableMessage: "You need to authenticate to access this operation.",
  };
  return jsonResponse(
    { errors: [{ message: "Authentication required, not authenticated", extensions }] },
    401,
  );
}

/** Linear's answer to an invalid `IssueFilter`: HTTP 400 with GraphQL `errors`. */
export function linearValidationError(message: string): Response {
  return jsonResponse(
    { errors: [{ message, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] },
    400,
  );
}

/** The `Authorization` value Azure DevOps expects for a PAT (empty user name). */
export function basicPatAuthorization(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

/**
 * Azure DevOps' answer to a wrong or missing PAT (a bare HTTP 401), or
 * undefined when no PAT is enforced or the request carries the right one.
 * `onReject` runs before each 401 so the fake can record the rejected request.
 */
export function rejectWrongPat(
  request: Request,
  pat: string | undefined,
  onReject: () => void,
): Response | undefined {
  if (pat === undefined || request.headers.get("authorization") === basicPatAuthorization(pat)) {
    return undefined;
  }
  onReject();
  return new Response(null, { status: 401, headers: { "www-authenticate": "Basic" } });
}
