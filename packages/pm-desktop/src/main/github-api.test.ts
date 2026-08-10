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
  test("returns empty without a token", async () => {
    expect(await listGitHubRepos(null)).toEqual([]);
  });

  test("maps API rows", async () => {
    const rows = await listGitHubRepos("tok", async () =>
      jsonResponse(200, [
        { full_name: "acme/web", private: true, default_branch: "develop" },
        { full_name: "bad" },
      ]),
    );
    expect(rows).toEqual([{ fullName: "acme/web", private: true, defaultBranch: "develop" }]);
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
});
