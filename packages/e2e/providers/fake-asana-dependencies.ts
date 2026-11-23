/**
 * Task dependencies ("Blocked by") for the in-process Asana fake
 * (`fake-asana.ts`): `GET /api/1.0/tasks/{gid}/dependencies`.
 *
 * The shape follows what `AsanaClient.listTaskDependencies` reads
 * (packages/task-trackers/src/clients/asana.ts): compact task records in
 * `data` honoring `opt_fields` (`gid` always present), and Asana's
 * `next_page` object (`offset`, `path`, `uri`) or `null` on the last page.
 * Offsets are opaque one-time cursors; an unknown one is a 400, as in Asana.
 * An injected status answers with Asana's `{"errors":[…]}` body instead.
 */

import { parseOptFields, projectTaskPayload } from "./fake-asana-fields";
import { json } from "./fake-asana-http";

/** One `GET /tasks/{gid}/dependencies` call the fake served. */
export interface FakeAsanaDependencyRequest {
  taskGid: string;
  /** `offset` query parameter, or null on a first page. */
  offset: string | null;
  /** `limit` query parameter as sent. */
  limit: string | null;
  /** Parsed `opt_fields` (empty when none were sent). */
  optFields: string[];
  /** HTTP status the fake answered with. */
  status: number;
  /** Blocker GIDs on the returned page. */
  returned: string[];
  /** `next_page.offset` the response carried, or null on the last page. */
  nextOffset: string | null;
}

/** The blocker fields the fake can return. */
export interface FakeAsanaBlocker {
  gid: string;
  name: string;
  completed: boolean;
}

/**
 * Asana error bodies for an injected failure. 402 is what Asana returns for
 * dependencies on a workspace without the feature; 500 carries Asana's
 * `phrase` field.
 */
const ERROR_BODIES: Record<number, { errors: Array<Record<string, string>> }> = {
  402: {
    errors: [
      {
        message: "This feature is only available to premium users.",
        help: "For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors",
      },
    ],
  },
  500: {
    errors: [{ message: "Server Error", phrase: "6 sad squid snuggle softly" }],
  },
};

/** Asana's default and maximum page sizes. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Dependency fixtures, pagination, failure injection, and the request log. */
export class FakeAsanaDependencies {
  /** Every dependencies call, oldest first. */
  readonly requests: FakeAsanaDependencyRequest[] = [];

  /** Blocker GIDs per dependent task GID, in page order. */
  private readonly blockers = new Map<string, string[]>();
  /** Live page offsets mapped to the index they resume at. */
  private readonly offsets = new Map<string, number>();
  /** Max records per page (below `limit` to force pagination). */
  private pageSize = MAX_LIMIT;
  private failure: { status: number; body: unknown } | undefined;

  set(taskGid: string, blockerGids: readonly string[]): void {
    this.blockers.set(taskGid, [...blockerGids]);
  }

  setPageSize(size: number): void {
    if (!Number.isInteger(size) || size < 1) throw new Error(`Invalid page size: ${size}`);
    this.pageSize = size;
  }

  fail(status: number | null): void {
    this.failure =
      status === null
        ? undefined
        : {
            status,
            body: ERROR_BODIES[status] ?? {
              errors: [{ message: `Injected fake Asana error ${status}` }],
            },
          };
  }

  /**
   * Serve one page for a known task. `lookup` reads a blocker's live state;
   * `reject` produces the fake's 400 diagnostic for an invalid offset.
   */
  serve(
    taskGid: string,
    url: URL,
    apiBaseUrl: string,
    lookup: (gid: string) => FakeAsanaBlocker,
    reject: (message: string) => Response,
  ): Response {
    const offset = url.searchParams.get("offset");
    const optFields = parseOptFields(url.searchParams.get("opt_fields"));
    const record = (status: number, returned: string[], nextOffset: string | null) =>
      this.requests.push({
        taskGid,
        offset,
        limit: url.searchParams.get("limit"),
        optFields: optFields ?? [],
        status,
        returned,
        nextOffset,
      });

    if (this.failure) {
      record(this.failure.status, [], null);
      return json(this.failure.body, this.failure.status);
    }

    const start = offset === null ? 0 : this.offsets.get(offset);
    if (start === undefined) {
      record(400, [], null);
      return reject(`offset: Your pagination token is invalid: ${offset}`);
    }
    if (offset !== null) this.offsets.delete(offset);

    const requested = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(requested) ? requested : DEFAULT_LIMIT, MAX_LIMIT, this.pageSize),
    );
    const all = this.blockers.get(taskGid) ?? [];
    const pageGids = all.slice(start, start + limit);
    const data = pageGids.map((gid) => {
      const blocker = lookup(gid);
      return projectTaskPayload(
        {
          gid: blocker.gid,
          resource_type: "task",
          resource_subtype: "default_task",
          name: blocker.name,
          completed: blocker.completed,
        },
        optFields,
      );
    });

    let nextPage: { offset: string; path: string; uri: string } | null = null;
    if (start + limit < all.length) {
      const token = `eyJ0eXAiOiJKV1Qi${crypto.randomUUID().replace(/-/g, "")}`;
      this.offsets.set(token, start + limit);
      const path = `/tasks/${taskGid}/dependencies?limit=${limit}&offset=${token}`;
      nextPage = { offset: token, path, uri: `${apiBaseUrl}${path}` };
    }
    record(200, pageGids, nextPage?.offset ?? null);
    return json({ data, next_page: nextPage });
  }
}
