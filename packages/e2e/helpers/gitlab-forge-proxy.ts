/**
 * Loopback front for {@link FakeGitlabForge} that adds project membership.
 *
 * The registered-MR poller (`GitLabReviewPollingAcquirer`) only treats a
 * discussion note as feedback when its author is an assigned reviewer or has
 * at least Developer access, which it reads from
 * `GET /projects/:id/members/all/:user_id`. The fake forge serves neither
 * (its MR has no reviewers and it has no members route), and it is shared
 * with sibling tasks, so this proxy composes the missing route in front of it
 * instead of editing it:
 *
 * - `GET /api/v4/projects/<1|fixture/repo>/members/all/<id>` is answered here
 *   with the configured access level (after the same `PRIVATE-TOKEN` check).
 * - Every other request is forwarded unchanged to the forge, so the forge's
 *   request log, discussion replies, and mergeability stay the evidence.
 * - JSON response bodies have the forge's base URL rewritten to the proxy's,
 *   so `web_url` values agree with the instance the worker is configured for.
 *
 * Only method and path are logged; no header or body is stored.
 */

import type { ForgeRequest } from "./fake-gitlab-forge";

export interface GitlabForgeProxyOptions {
  /** Base URL of the running fake forge. */
  forgeUrl: string;
  /** Expected `PRIVATE-TOKEN` for the member route (forwarded requests are checked by the forge). */
  token: string;
  /** Access level per user id; users not listed get 404 (not a member). */
  members: Record<number, number>;
}

const MEMBER_ROUTE =
  /^\/api\/v4\/projects\/(?:1|fixture%2Frepo|fixture\/repo)\/members\/all\/(\d+)$/;

/** Minimal reverse proxy bound to `127.0.0.1`. */
export class GitlabForgeProxy {
  /** Member lookups this proxy answered itself. */
  readonly memberLookups: ForgeRequest[] = [];
  readonly baseUrl: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly options: GitlabForgeProxyOptions;

  constructor(options: GitlabForgeProxyOptions) {
    this.options = options;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    const port = this.server.port;
    if (port === undefined || port === 0) {
      this.server.stop(true);
      throw new Error("GitLab forge proxy did not receive a loopback port");
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const member = request.method === "GET" ? url.pathname.match(MEMBER_ROUTE) : null;
    if (member?.[1]) {
      this.memberLookups.push({ method: request.method, path: `${url.pathname}${url.search}` });
      if (request.headers.get("private-token") !== this.options.token) {
        return Response.json({ message: "unauthorized" }, { status: 401 });
      }
      const id = Number(member[1]);
      const level = this.options.members[id];
      if (level === undefined) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json({ id, username: `user-${id}`, state: "active", access_level: level });
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const upstream = await fetch(`${this.options.forgeUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
    });
    const text = await upstream.text();
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    return new Response(text.split(this.options.forgeUrl).join(this.baseUrl), {
      status: upstream.status,
      headers: responseHeaders,
    });
  }
}
