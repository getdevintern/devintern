import { afterEach, describe, expect, test } from "bun:test";

import { GitHubReviewsClient } from "../src/lib/github-reviews";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const mockFetch = (
  fn: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
) => fn as unknown as typeof fetch;

/**
 * Conflict resolution keys off GitHub's computed mergeability. The client
 * passes the raw PR API payload through unfiltered — these tests guard that
 * `mergeable_state`/`mergeable` actually reach callers instead of being
 * dropped by a future response-mapping refactor.
 */
describe("GitHubReviewsClient.getPullRequest", () => {
  test("token-only mode never falls back to a custom GitHub App", async () => {
    let authorization = "";
    globalThis.fetch = mockFetch(async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return jsonResponse(200, {
        number: 7,
        title: "Test PR",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/7",
        head: { ref: "feature/change", sha: "abc" },
        base: { ref: "main", sha: "def" },
      });
    });

    const appAuth = {
      getTokenForRepository: async () => {
        throw new Error("custom App must not be used");
      },
    };
    const client = new GitHubReviewsClient({
      token: "workspace-token",
      appAuth: appAuth as never,
      authMode: "token-only",
    });
    await client.getPullRequest("acme", "widgets", 7);

    expect(authorization).toBe("Bearer workspace-token");
  });

  test("app-first mode preserves customer-owned App auth for no-relay installs", async () => {
    let authorization = "";
    globalThis.fetch = mockFetch(async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return jsonResponse(200, {
        number: 8,
        title: "Air-gapped PR",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/8",
        head: { ref: "feature/offline", sha: "abc" },
        base: { ref: "main", sha: "def" },
      });
    });

    const appAuth = {
      getTokenForRepository: async () => "customer-app-token",
    };
    const client = new GitHubReviewsClient({
      token: "fallback-pat",
      appAuth: appAuth as never,
      authMode: "app-first",
    });
    await client.getPullRequest("acme", "widgets", 8);

    expect(authorization).toBe("Bearer customer-app-token");
  });

  test("surfaces mergeable_state and mergeable from the API payload", async () => {
    globalThis.fetch = mockFetch(async () =>
      jsonResponse(200, {
        number: 7,
        title: "Test PR",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/7",
        head: { ref: "feature/change", sha: "abc", repo: { full_name: "acme/widgets" } },
        base: { ref: "main", sha: "def" },
        // Recomputed asynchronously; must not be stripped by the client.
        mergeable: false,
        mergeable_state: "dirty",
      }),
    );

    const client = new GitHubReviewsClient({ token: "test-token" });
    const pr = await client.getPullRequest("acme", "widgets", 7);

    expect(pr.mergeable_state).toBe("dirty");
    expect((pr as PullRequestWithMergeable).mergeable).toBe(false);
    expect(pr.state).toBe("open");
    expect(pr.head.sha).toBe("abc");
  });

  test("leaves mergeable_state absent while GitHub has never computed it", async () => {
    globalThis.fetch = mockFetch(async () =>
      jsonResponse(200, {
        number: 8,
        title: "Fresh PR",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/8",
        head: { ref: "feature/new", sha: "111", repo: null },
        base: { ref: "main", sha: "222" },
        mergeable: null,
        // No mergeable_state key at all.
      }),
    );

    const client = new GitHubReviewsClient({ token: "test-token" });
    const pr = await client.getPullRequest("acme", "widgets", 8);

    expect(pr.mergeable_state).toBeUndefined();
    expect((pr as PullRequestWithMergeable).mergeable).toBeNull();
  });
});

/** `mergeable` exists on the wire format but is not part of PullRequestInfo. */
type PullRequestWithMergeable = { mergeable?: boolean | null };
