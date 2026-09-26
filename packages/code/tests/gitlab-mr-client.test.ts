import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GitLabMRClient,
  isGitLabCodeHostEnabled,
  resolveGitLabCodeHostConfig,
} from "../src/lib/code-host";
import type { PRInfo } from "../src/lib/code-host";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const prInfo = (overrides: Partial<PRInfo> = {}): PRInfo => ({
  title: "[DEV-1] Test task",
  body: "MR body",
  sourceBranch: "feature/dev-1",
  targetBranch: "main",
  repository: "acme/platform/widgets",
  ...overrides,
});

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const mockFetch = (
  fn: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
) => fn as unknown as typeof fetch;

const project = {
  id: 17,
  path_with_namespace: "acme/platform/widgets",
  default_branch: "trunk",
  web_url: "https://gitlab.com/acme/platform/widgets",
};

function successfulInfrastructure(
  requests: Array<{ url: string; init?: RequestInit }>,
  createBody: Record<string, unknown> = {},
) {
  return mockFetch(async (url, init) => {
    const value = String(url);
    requests.push({ url: value, init });
    if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
      return jsonResponse(200, project);
    }
    if (value.includes("/repository/branches/")) return jsonResponse(200, { name: "branch" });
    if (value.includes("/labels?")) {
      return jsonResponse(200, [{ name: "devintern" }, { name: "Backend" }]);
    }
    if (value.endsWith("/merge_requests") && init?.method === "POST") {
      return jsonResponse(201, {
        iid: 9,
        web_url: "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
        source_branch: "feature/dev-1",
        target_branch: "main",
        source_project_id: 17,
        target_project_id: 17,
        ...createBody,
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${value}`);
  });
}

describe("isGitLabCodeHostEnabled", () => {
  test("requires an explicit affirmative value", () => {
    expect(isGitLabCodeHostEnabled("true")).toBe(true);
    expect(isGitLabCodeHostEnabled("1")).toBe(true);
    expect(isGitLabCodeHostEnabled("YES")).toBe(true);
    expect(isGitLabCodeHostEnabled(undefined)).toBe(false);
    expect(isGitLabCodeHostEnabled("false")).toBe(false);
  });
});

describe("resolveGitLabCodeHostConfig", () => {
  test("keeps task-tracker and code-host tokens independent", () => {
    expect(
      resolveGitLabCodeHostConfig("https://git.example.test", {
        DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
        GITLAB_CODE_HOST_URL: "https://git.example.test",
        GITLAB_CODE_HOST_TOKEN: "code-token",
        TASK_TRACKER: "gitlab",
        GITLAB_BASE_URL: "https://tracker.example.test",
        GITLAB_TOKEN: "tracker-token",
      }),
    ).toMatchObject({ ok: true, token: "code-token" });
  });

  test("reuses a GitLab tracker token only for the exact same instance", () => {
    const shared = {
      DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
      GITLAB_CODE_HOST_URL: "https://git.example.test/gitlab/",
      TASK_TRACKER: "gitlab",
      GITLAB_BASE_URL: "https://git.example.test/gitlab",
      GITLAB_TOKEN: "tracker-token",
    };
    expect(resolveGitLabCodeHostConfig("https://git.example.test/gitlab", shared)).toMatchObject({
      ok: true,
      token: "tracker-token",
    });
    expect(
      resolveGitLabCodeHostConfig("https://gitlab.com", {
        ...shared,
        GITLAB_CODE_HOST_URL: "https://gitlab.com",
      }),
    ).toMatchObject({ ok: false });
  });

  test("requires opt-in and an instance match", () => {
    expect(
      resolveGitLabCodeHostConfig("https://gitlab.com", { GITLAB_CODE_HOST_TOKEN: "token" }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("experimental") });
    expect(
      resolveGitLabCodeHostConfig("https://other.example.test", {
        DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
        GITLAB_CODE_HOST_URL: "https://git.example.test",
        GITLAB_CODE_HOST_TOKEN: "token",
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("remote belongs") });
  });
});

describe("GitLabMRClient", () => {
  test("creates an MR and filters labels to existing project labels", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = successfulInfrastructure(requests);

    const result = await new GitLabMRClient("glpat-test").createPullRequest(
      prInfo({ labels: ["devintern", "backend", "missing"] }),
    );

    expect(result.success).toBe(true);
    expect(result.changeRequest).toEqual({
      provider: "gitlab",
      instanceUrl: "https://gitlab.com",
      projectId: "17",
      projectPath: "acme/platform/widgets",
      number: 9,
      webUrl: "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
    });
    expect(result.warnings).toEqual(["GitLab labels do not exist and were skipped: missing"]);
    const create = requests.find((request) => request.init?.method === "POST");
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({
      source_branch: "feature/dev-1",
      target_branch: "main",
      labels: "devintern,Backend",
      remove_source_branch: false,
    });
    expect(requests[0]?.url).toContain("/projects/acme%2Fplatform%2Fwidgets");
    expect(new Headers(requests[0]?.init?.headers).get("PRIVATE-TOKEN")).toBe("glpat-test");
  });

  test("uses the API-reported default branch when no target is supplied", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = successfulInfrastructure(requests, { target_branch: "trunk" });

    const result = await new GitLabMRClient("token").createPullRequest(
      prInfo({ targetBranch: "" }),
    );

    expect(result.success).toBe(true);
    const create = requests.find((request) => request.init?.method === "POST");
    expect(JSON.parse(String(create?.init?.body)).target_branch).toBe("trunk");
  });

  test("follows GitLab Link pagination while checking existing labels", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockFetch(async (url, init) => {
      const value = String(url);
      requests.push({ url: value, init });
      if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
        return jsonResponse(200, project);
      }
      if (value.includes("/repository/branches/")) return jsonResponse(200, {});
      if (value.includes("/labels?") && value.includes("&page=1")) {
        return jsonResponse(200, [], {
          Link: '<https://gitlab.com/api/v4/projects/17/labels?per_page=100&page=2>; rel="next"',
        });
      }
      if (value.includes("/labels?") && value.includes("&page=2")) {
        return jsonResponse(200, [{ name: "devintern" }]);
      }
      if (value.endsWith("/merge_requests")) {
        return jsonResponse(201, {
          iid: 9,
          web_url: "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    });

    const result = await new GitLabMRClient("token").createPullRequest(
      prInfo({ labels: ["devintern"] }),
    );

    expect(result.success).toBe(true);
    expect(requests.filter((request) => request.url.includes("/labels?"))).toHaveLength(2);
    const create = requests.find((request) => request.init?.method === "POST");
    expect(JSON.parse(String(create?.init?.body)).labels).toBe("devintern");
  });

  test("recovers only an exact same-project source and target match", async () => {
    globalThis.fetch = mockFetch(async (url, init) => {
      const value = String(url);
      if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
        return jsonResponse(200, project);
      }
      if (value.includes("/repository/branches/")) return jsonResponse(200, {});
      if (value.endsWith("/merge_requests") && init?.method === "POST") {
        return jsonResponse(409, { message: "Another open merge request already exists" });
      }
      if (value.includes("/merge_requests?")) {
        return jsonResponse(200, [
          {
            iid: 8,
            web_url: "https://gitlab.com/fork/widgets/-/merge_requests/8",
            source_branch: "feature/dev-1",
            target_branch: "main",
            source_project_id: 99,
            target_project_id: 17,
          },
          {
            iid: 9,
            web_url: "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
            source_branch: "feature/dev-1",
            target_branch: "main",
            source_project_id: 17,
            target_project_id: 17,
          },
        ]);
      }
      throw new Error(`Unexpected request: ${value}`);
    });

    const result = await new GitLabMRClient("token").createPullRequest(prInfo());

    expect(result.success).toBe(true);
    expect(result.url).toEndWith("/merge_requests/9");
    expect(result.message).toContain("already exists");
  });

  test("does not recover a non-matching MR", async () => {
    globalThis.fetch = mockFetch(async (url, init) => {
      const value = String(url);
      if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
        return jsonResponse(200, project);
      }
      if (value.includes("/repository/branches/")) return jsonResponse(200, {});
      if (value.endsWith("/merge_requests") && init?.method === "POST") {
        return jsonResponse(409, { message: "Another open merge request already exists" });
      }
      if (value.includes("/merge_requests?")) {
        return jsonResponse(200, [
          {
            iid: 8,
            web_url: "https://gitlab.com/acme/platform/widgets/-/merge_requests/8",
            source_branch: "other",
            target_branch: "main",
            source_project_id: 17,
            target_project_id: 17,
          },
        ]);
      }
      throw new Error(`Unexpected request: ${value}`);
    });

    const result = await new GitLabMRClient("token").createPullRequest(prInfo());
    expect(result.success).toBe(false);
    expect(result.message).toContain("Another open merge request already exists");
  });

  test("skips all labels when label lookup fails", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockFetch(async (url, init) => {
      const value = String(url);
      requests.push({ url: value, init });
      if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
        return jsonResponse(200, project);
      }
      if (value.includes("/repository/branches/")) return jsonResponse(200, {});
      if (value.includes("/labels?")) return jsonResponse(403, { message: "Forbidden" });
      if (value.endsWith("/merge_requests")) {
        return jsonResponse(201, {
          iid: 9,
          web_url: "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    });

    const result = await new GitLabMRClient("token").createPullRequest(
      prInfo({ labels: ["devintern"] }),
    );

    expect(result.success).toBe(true);
    expect(result.warnings?.[0]).toContain("no labels were applied");
    const create = requests.find((request) => request.init?.method === "POST");
    expect(JSON.parse(String(create?.init?.body))).not.toHaveProperty("labels");
  });

  test("fails before creation when a branch is unavailable", async () => {
    let created = false;
    globalThis.fetch = mockFetch(async (url, init) => {
      const value = String(url);
      if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
        return jsonResponse(200, project);
      }
      if (value.includes("/repository/branches/feature%2Fdev-1")) {
        return jsonResponse(404, { message: "404 Branch Not Found" });
      }
      if (init?.method === "POST") created = true;
      return jsonResponse(200, {});
    });

    const result = await new GitLabMRClient("token").createPullRequest(prInfo());
    expect(result.success).toBe(false);
    expect(result.message).toContain("source branch 'feature/dev-1'");
    expect(created).toBe(false);
  });

  test("warns on an unvalidated self-managed version and passes CA/proxy options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gitlab-ca-"));
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, "test-ca");
    let extendedOptions: Record<string, unknown> | undefined;
    try {
      globalThis.fetch = mockFetch(async (url, init) => {
        const value = String(url);
        extendedOptions = init as unknown as Record<string, unknown>;
        if (value.endsWith("/version")) return jsonResponse(200, { version: "18.11.4" });
        if (value.includes("/projects/acme%2Fplatform%2Fwidgets")) {
          return jsonResponse(200, project);
        }
        if (value.includes("/repository/branches/")) return jsonResponse(200, {});
        if (value.endsWith("/merge_requests")) {
          return jsonResponse(201, {
            iid: 3,
            web_url: "https://git.example.test/acme/platform/widgets/-/merge_requests/3",
          });
        }
        throw new Error(`Unexpected request: ${value}`);
      });

      const result = await new GitLabMRClient("token", "https://git.example.test", {
        caFile,
        proxy: "http://proxy.example.test:8080",
      }).createPullRequest(prInfo());

      expect(result.success).toBe(true);
      expect(result.warnings?.[0]).toContain("outside the validated 19.3.x release");
      expect(extendedOptions?.tls).toEqual({ ca: "test-ca" });
      expect(extendedOptions?.proxy).toBe("http://proxy.example.test:8080");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
