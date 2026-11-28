import { afterEach, describe, expect, test } from "bun:test";
import { TrelloClient } from "./src/clients/trello.ts";
import { defaultProbe } from "./src/init/wizard-core.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Handler = (url: URL) => { status?: number; json?: unknown };

function mockFetch(handler: Handler): URL[] {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    urls.push(url);
    const result = handler(url);
    return new Response(JSON.stringify(result.json ?? {}), { status: result.status ?? 200 });
  }) as typeof fetch;
  return urls;
}

const JIRA_ENV = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "bot@acme.com",
  JIRA_API_TOKEN: "bad-token-value",
};

describe("defaultProbe jira", () => {
  test("probes /myself so a rejected token fails (project search answers 200 anonymously)", async () => {
    const urls = mockFetch((url) =>
      url.pathname === "/rest/api/3/myself"
        ? { status: 401, json: { message: "Unauthorized" } }
        : { json: { values: [] } },
    );
    await expect(defaultProbe("jira", JIRA_ENV)).rejects.toThrow(/401/);
    expect(urls.map((u) => u.pathname)).toEqual(["/rest/api/3/myself"]);
  });

  test("passes when /myself answers 200", async () => {
    mockFetch(() => ({ json: { displayName: "Bot" } }));
    await expect(defaultProbe("jira", JIRA_ENV)).resolves.toBeUndefined();
  });
});

describe("defaultProbe github", () => {
  const base = { GITHUB_TOKEN: "tok" };

  test("checks the configured repo and names it when the token cannot see it", async () => {
    const urls = mockFetch((url) =>
      url.pathname === "/repos/acme/webapp" ? { status: 404, json: { message: "Not Found" } } : {},
    );
    const error = await defaultProbe("github", { ...base, GITHUB_REPO: "acme/webapp" }).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toContain("acme/webapp");
    expect((error as Error).message).toContain("cannot access");
    expect(urls.map((u) => u.pathname)).toEqual(["/repos/acme/webapp"]);
  });

  test("passes when the repo is visible", async () => {
    mockFetch(() => ({ json: { full_name: "acme/webapp" } }));
    await expect(
      defaultProbe("github", { ...base, GITHUB_REPO: "acme/webapp" }),
    ).resolves.toBeUndefined();
  });

  test("without GITHUB_REPO only the token is checked via /user", async () => {
    const urls = mockFetch(() => ({ json: { login: "me" } }));
    await defaultProbe("github", base);
    expect(urls.map((u) => u.pathname)).toEqual(["/user"]);
  });

  test("a rejected token fails without GITHUB_REPO", async () => {
    mockFetch(() => ({ status: 401, json: { message: "Bad credentials" } }));
    await expect(defaultProbe("github", base)).rejects.toThrow(/401/);
  });
});

describe("TrelloClient.resolveBoardId / searchCards", () => {
  const LONG = "5f1c2a3b4d5e6f7a8b9c0d1e";

  function client(): TrelloClient {
    return new TrelloClient({ apiKey: "k", apiToken: "t", baseUrl: "https://trello.test/1" });
  }

  test("resolves a short board id once and searches with the long id", async () => {
    const urls = mockFetch((url) =>
      url.pathname === "/1/boards/AbCd1234" ? { json: { id: LONG } } : { json: { cards: [] } },
    );
    const trello = client();
    await trello.searchCards("is:open", "AbCd1234");
    await trello.searchCards("is:open", "AbCd1234");

    const lookups = urls.filter((u) => u.pathname === "/1/boards/AbCd1234");
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.searchParams.get("fields")).toBe("id");
    const searches = urls.filter((u) => u.pathname === "/1/search");
    expect(searches).toHaveLength(2);
    for (const search of searches) expect(search.searchParams.get("idBoards")).toBe(LONG);
  });

  test("passes a 24-character id through without a lookup", async () => {
    const urls = mockFetch(() => ({ json: { cards: [] } }));
    await client().searchCards("is:open", LONG);
    expect(urls.map((u) => u.pathname)).toEqual(["/1/search"]);
    expect(urls[0]?.searchParams.get("idBoards")).toBe(LONG);
  });

  test("a failed lookup is not cached", async () => {
    let calls = 0;
    mockFetch((url) => {
      if (url.pathname === "/1/boards/AbCd1234") {
        calls++;
        return calls === 1 ? { status: 404 } : { json: { id: LONG } };
      }
      return { json: { cards: [] } };
    });
    const trello = client();
    await expect(trello.resolveBoardId("AbCd1234")).rejects.toThrow(/404/);
    await expect(trello.resolveBoardId("AbCd1234")).resolves.toBe(LONG);
  });
});

describe("defaultProbe azure-devops base URL", () => {
  const AZURE_ENV = {
    AZURE_DEVOPS_ORG: "myorg",
    AZURE_DEVOPS_PAT: "pat",
    AZURE_DEVOPS_PROJECT: "MyProject",
  };

  test("calls production when the e2e fake is not opted in, even with a loopback base URL", async () => {
    const urls = mockFetch(() => ({ json: { value: [] } }));
    await defaultProbe(
      "azure-devops",
      { ...AZURE_ENV, AZURE_DEVOPS_BASE_URL: "http://127.0.0.1:9/fakeorg" },
      { allowAzureDevOpsFake: false },
    );
    expect(urls.map((u) => u.origin + u.pathname)).toEqual([
      "https://dev.azure.com/myorg/_apis/projects",
    ]);
  });

  test("calls production when opted in without a base URL", async () => {
    const urls = mockFetch(() => ({ json: { value: [] } }));
    await defaultProbe("azure-devops", AZURE_ENV, { allowAzureDevOpsFake: true });
    expect(urls.map((u) => u.origin + u.pathname)).toEqual([
      "https://dev.azure.com/myorg/_apis/projects",
    ]);
  });

  test("calls the loopback fake when opted in", async () => {
    const urls = mockFetch(() => ({ json: { value: [] } }));
    await defaultProbe(
      "azure-devops",
      { ...AZURE_ENV, AZURE_DEVOPS_BASE_URL: "http://127.0.0.1:9/fakeorg/" },
      { allowAzureDevOpsFake: true },
    );
    expect(urls.map((u) => u.origin + u.pathname)).toEqual([
      "http://127.0.0.1:9/fakeorg/_apis/projects",
    ]);
  });

  test("refuses a non-loopback base URL when opted in, without any request", async () => {
    const urls = mockFetch(() => ({ json: { value: [] } }));
    await expect(
      defaultProbe(
        "azure-devops",
        { ...AZURE_ENV, AZURE_DEVOPS_BASE_URL: "https://attacker.example/collect" },
        { allowAzureDevOpsFake: true },
      ),
    ).rejects.toThrow("AZURE_DEVOPS_BASE_URL must be an absolute loopback http(s) URL");
    expect(urls).toEqual([]);
  });
});
