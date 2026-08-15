import { describe, expect, test } from "bun:test";
import { listGitHubRepos, probeGitHubRepo, validateGitHubToken } from "./github-api.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("probeGitHubRepo", () => {
  const ref = { owner: "acme", repo: "web", slug: "acme/web" };

  test("returns repo metadata on success", async () => {
    const result = await probeGitHubRepo(ref, "tok", async () =>
      jsonResponse(200, {
        full_name: "acme/web",
        private: false,
        default_branch: "main",
        clone_url: "https://github.com/acme/web.git",
      }),
    );
    expect(result).toEqual({
      ok: true,
      fullName: "acme/web",
      private: false,
      defaultBranch: "main",
      cloneUrl: "https://github.com/acme/web.git",
    });
  });

  test("asks for auth on 404 without a token (private-or-missing)", async () => {
    const result = await probeGitHubRepo(ref, null, async () => jsonResponse(404, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("auth_required");
  });

  test("reports not_found when authenticated 404", async () => {
    const result = await probeGitHubRepo(ref, "tok", async () => jsonResponse(404, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
  });

  test("reports forbidden when token lacks access", async () => {
    const result = await probeGitHubRepo(ref, "tok", async () => jsonResponse(403, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden");
  });
});

describe("validateGitHubToken", () => {
  test("accepts a valid token", async () => {
    const result = await validateGitHubToken("tok", async () =>
      jsonResponse(200, { login: "dana" }),
    );
    expect(result).toEqual({ ok: true, login: "dana" });
  });

  test("rejects 401", async () => {
    const result = await validateGitHubToken("bad", async () => jsonResponse(401, {}));
    expect(result.ok).toBe(false);
  });
});

describe("listGitHubRepos", () => {
  test("throws auth_required without a token instead of empty list", async () => {
    await expect(listGitHubRepos(null)).rejects.toMatchObject({
      code: "auth_required",
    });
  });

  test("maps PAT /user/repos rows", async () => {
    const rows = await listGitHubRepos("tok", async () =>
      jsonResponse(200, [
        { full_name: "acme/web", private: true, default_branch: "develop" },
        { full_name: "bad" },
      ]),
    );
    expect(rows).toEqual([{ fullName: "acme/web", private: true, defaultBranch: "develop" }]);
  });

  test("throws on non-array /user/repos payload instead of empty list", async () => {
    await expect(
      listGitHubRepos("tok", async () => jsonResponse(200, { repositories: [] })),
    ).rejects.toMatchObject({ code: "error" });
  });

  test("throws auth_required on 401 instead of empty list", async () => {
    await expect(listGitHubRepos("bad", async () => jsonResponse(401, {}))).rejects.toMatchObject({
      code: "auth_required",
    });
  });

  test("throws rate_limited on 403 rate-limit body", async () => {
    await expect(
      listGitHubRepos("tok", async () => new Response("API rate limit exceeded", { status: 403 })),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  test("maps aborted fetches to a clear timeout error", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    await expect(
      listGitHubRepos("tok", async () => {
        throw abortErr;
      }),
    ).rejects.toMatchObject({
      code: "error",
      message: expect.stringMatching(/timed out/i),
    });
  });

  test("lists GitHub App user-token repos via installations, not /user/repos", async () => {
    const paths: string[] = [];
    const rows = await listGitHubRepos("ghu_token", async (input) => {
      const url = new URL(input);
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/user/installations") {
        return jsonResponse(200, {
          total_count: 2,
          installations: [{ id: 11 }, { id: 22 }],
        });
      }
      if (url.pathname === "/user/installations/11/repositories") {
        return jsonResponse(200, {
          total_count: 1,
          repositories: [{ full_name: "acme/web", private: true, default_branch: "develop" }],
        });
      }
      if (url.pathname === "/user/installations/22/repositories") {
        return jsonResponse(200, {
          total_count: 1,
          repositories: [{ full_name: "acme/api", private: false, default_branch: "main" }],
        });
      }
      return jsonResponse(500, { message: `unexpected ${url.pathname}` });
    });
    expect(rows).toEqual([
      { fullName: "acme/web", private: true, defaultBranch: "develop" },
      { fullName: "acme/api", private: false, defaultBranch: "main" },
    ]);
    expect(paths.some((p) => p.startsWith("/user/repos"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/user/installations?"))).toBe(true);
  });

  test("dedupes the same repo across installations", async () => {
    const rows = await listGitHubRepos("ghu_token", async (input) => {
      const url = new URL(input);
      if (url.pathname === "/user/installations") {
        return jsonResponse(200, { installations: [{ id: 1 }, { id: 2 }] });
      }
      return jsonResponse(200, {
        repositories: [{ full_name: "acme/web", private: true, default_branch: "main" }],
      });
    });
    expect(rows).toEqual([{ fullName: "acme/web", private: true, defaultBranch: "main" }]);
  });

  test("returns empty when the GitHub App has no installations", async () => {
    const rows = await listGitHubRepos("ghu_token", async (input) => {
      const url = new URL(input);
      if (url.pathname === "/user/installations") {
        return jsonResponse(200, { total_count: 0, installations: [] });
      }
      return jsonResponse(500, { message: `unexpected ${url.pathname}` });
    });
    expect(rows).toEqual([]);
  });

  test("throws when installations payload is not the documented object", async () => {
    await expect(
      listGitHubRepos("ghu_token", async () => jsonResponse(200, [{ id: 1 }])),
    ).rejects.toMatchObject({ code: "error" });
  });
});
