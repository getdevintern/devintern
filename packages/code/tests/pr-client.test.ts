import { afterEach, describe, expect, test } from "bun:test";
import { GitHubPRClient, isTransientPrFailure, parsePrLabels } from "../src/lib/pr-client";
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

describe("parsePrLabels", () => {
  test("splits a comma-separated value and drops empties", () => {
    expect(parsePrLabels("devintern, auto-pr,, backend ")).toEqual([
      "devintern",
      "auto-pr",
      "backend",
    ]);
    expect(parsePrLabels(undefined)).toEqual([]);
    expect(parsePrLabels("")).toEqual([]);
    expect(parsePrLabels(" , ")).toEqual([]);
  });
});

describe("GitHubPRClient label application", () => {
  test("labels the PR after a successful create", async () => {
    const labelBodies: unknown[] = [];
    let labelRequested = "";
    globalThis.fetch = mockFetch(async (url, init) => {
      if (String(url).endsWith("/pulls") && init?.method === "POST") {
        return jsonResponse(201, {
          html_url: "https://github.com/owner/repo/pull/7",
          number: 7,
        });
      }
      labelRequested = String(url);
      labelBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, []);
    });

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo({ labels: ["devintern", "auto-pr"] }));

    expect(result.success).toBe(true);
    expect(labelRequested).toBe("https://api.github.com/repos/owner/repo/issues/7/labels");
    expect(labelBodies).toEqual([{ labels: ["devintern", "auto-pr"] }]);
  });

  test("does not label when no labels are configured", async () => {
    let labelCalled = false;
    globalThis.fetch = mockFetch(async (url, init) => {
      if (String(url).endsWith("/pulls") && init?.method === "POST") {
        return jsonResponse(201, {
          html_url: "https://github.com/owner/repo/pull/7",
          number: 7,
        });
      }
      labelCalled = true;
      return jsonResponse(200, []);
    });

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo());

    expect(result.success).toBe(true);
    expect(labelCalled).toBe(false);
  });

  test("labels an already-existing PR found via the 422 lookup", async () => {
    let labelRequested = "";
    globalThis.fetch = mockFetch(async (url, init) => {
      if (init?.method === "POST" && String(url).endsWith("/pulls")) {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: ["A pull request already exists for owner:feature/dev-1."],
        });
      }
      if (String(url).includes("/pulls?head=")) {
        return jsonResponse(200, [{ html_url: "https://github.com/owner/repo/pull/3" }]);
      }
      labelRequested = String(url);
      return jsonResponse(200, []);
    });

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo({ labels: ["devintern"] }));

    expect(result.success).toBe(true);
    expect(labelRequested).toBe("https://api.github.com/repos/owner/repo/issues/3/labels");
  });

  test("label failure does not fail PR creation", async () => {
    globalThis.fetch = mockFetch(async (url, init) => {
      if (String(url).endsWith("/pulls") && init?.method === "POST") {
        return jsonResponse(201, {
          html_url: "https://github.com/owner/repo/pull/7",
          number: 7,
        });
      }
      return jsonResponse(403, { message: "Resource not accessible by integration" });
    });

    const client = new GitHubPRClient("test-token");
    const result = await client.createPullRequest(basePrInfo({ labels: ["devintern"] }));

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://github.com/owner/repo/pull/7");
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
