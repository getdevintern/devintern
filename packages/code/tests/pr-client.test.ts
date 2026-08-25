import { afterEach, describe, expect, test } from "bun:test";
import { GitHubPRClient, isTransientPrFailure } from "../src/lib/pr-client";
import type { PRInfo } from "../src/lib/pr-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const basePrInfo = (overrides: Partial<PRInfo> = {}): PRInfo => ({
  title: "[DEV-1] Test task",
  body: "PR body",
  sourceBranch: "feature/dev-1",
  targetBranch: "main",
  repository: "owner/repo",
  ...overrides,
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const mockFetch = (
  fn: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
) => fn as unknown as typeof fetch;

describe("isTransientPrFailure", () => {
  test("matches transport-level failures", () => {
    expect(
      isTransientPrFailure("GitHub PR creation failed: Was there a typo in the url or port?"),
    ).toBe(true);
    expect(isTransientPrFailure("GitHub PR creation failed: fetch failed")).toBe(true);
    expect(isTransientPrFailure("GitHub PR creation failed: ETIMEDOUT")).toBe(true);
    expect(isTransientPrFailure("request timed out after 5000ms")).toBe(true);
    expect(isTransientPrFailure("getaddrinfo ENOTFOUND api.github.com")).toBe(true);
    expect(isTransientPrFailure("socket hang up")).toBe(true);
  });

  test("does not match API-level validation failures", () => {
    expect(isTransientPrFailure("Validation Failed")).toBe(false);
    expect(isTransientPrFailure("Bad credentials")).toBe(false);
    expect(isTransientPrFailure("Not Found")).toBe(false);
    expect(
      isTransientPrFailure(
        "GitHub client not configured. Please set GITHUB_TOKEN or configure GitHub App.",
      ),
    ).toBe(false);
  });
});

describe("GitHubPRClient.createPullRequest", () => {
  test("returns success with PR url on 201", async () => {
    globalThis.fetch = mockFetch(async () =>
      jsonResponse(201, { html_url: "https://github.com/owner/repo/pull/7" }),
    );

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo());

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://github.com/owner/repo/pull/7");
  });

  test("treats 422 already-exists as success via existing-PR lookup", async () => {
    let listCalled = false;
    globalThis.fetch = mockFetch(async (_url, init) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: ["A pull request already exists for owner:feature/dev-1."],
        });
      }
      listCalled = true;
      return jsonResponse(200, [{ html_url: "https://github.com/owner/repo/pull/3" }]);
    });

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo());

    expect(listCalled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://github.com/owner/repo/pull/3");
    expect(result.message).toContain("already exists");
  });

  test("fails on 422 when no existing PR is found", async () => {
    globalThis.fetch = mockFetch(async (_url, init) => {
      if (init?.method === "POST") {
        return jsonResponse(422, { message: "Validation Failed" });
      }
      return jsonResponse(200, []);
    });

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo());

    expect(result.success).toBe(false);
    expect(result.message).toContain("Validation Failed");
  });

  test("fails fast on non-transient API errors", async () => {
    let attempts = 0;
    globalThis.fetch = mockFetch(async () => {
      attempts++;
      return jsonResponse(404, { message: "Not Found" });
    });

    const client = new GitHubPRClient("bad-token");
    const result = await client.createPullRequest(basePrInfo());

    expect(attempts).toBe(1); // no retry and no lookup for non-transient errors
    expect(result.success).toBe(false);
    expect(result.message).toContain("Not Found");
  });
});
