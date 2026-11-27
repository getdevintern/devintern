/**
 * `defaultDevinternLabelOps`: the real tracker label lookup and creation the
 * wizard and `--create-label` use, built from the worker credentials.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { defaultDevinternLabelOps } from "../src/lib/init/worker-init-label";
import { DEVINTERN_LABEL } from "../src/lib/trackers/capabilities";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type CapturedRequest = { url: string; method: string; body?: unknown };

function mockFetch(handler: (req: CapturedRequest) => { status?: number; json?: unknown }) {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const result = handler(req);
    return new Response(JSON.stringify(result.json ?? {}), { status: result.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const GITHUB_ENV = { GITHUB_TOKEN: "ghp_secret", GITHUB_REPO: "acme/app" };
const GITLAB_ENV = { GITLAB_TOKEN: "glpat-secret", GITLAB_PROJECT: "acme/team/app" };

describe("defaultDevinternLabelOps", () => {
  test("returns undefined for trackers without label creation", () => {
    for (const tracker of ["jira", "linear", "azure-devops", "trello", "asana", "markdown"]) {
      expect(defaultDevinternLabelOps(tracker, GITHUB_ENV)).toBeUndefined();
    }
  });

  test("returns undefined for github when credentials are incomplete", () => {
    expect(defaultDevinternLabelOps("github", {})).toBeUndefined();
    expect(defaultDevinternLabelOps("github", { GITHUB_TOKEN: "tok" })).toBeUndefined();
    expect(
      defaultDevinternLabelOps("github", { GITHUB_TOKEN: "tok", GITHUB_REPO: "no-slash" }),
    ).toBeUndefined();
  });

  test("github: exists asks the labels endpoint and reports the result", async () => {
    const calls = mockFetch(() => ({ json: { name: DEVINTERN_LABEL } }));
    const ops = defaultDevinternLabelOps("github", GITHUB_ENV)!;

    await expect(ops.exists()).resolves.toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`https://api.github.com/repos/acme/app/labels/${DEVINTERN_LABEL}`);

    mockFetch(() => ({ status: 404, json: { message: "Not Found" } }));
    await expect(ops.exists()).resolves.toBe(false);
  });

  test("github: create posts the devintern label options", async () => {
    const calls = mockFetch(() => ({ json: { name: DEVINTERN_LABEL } }));
    const ops = defaultDevinternLabelOps("github", GITHUB_ENV)!;

    await ops.create();

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/app/labels");
    expect(calls[0].body).toMatchObject({
      name: DEVINTERN_LABEL,
      color: "5319e7",
      description: expect.stringContaining("Ready for DevIntern"),
    });
  });

  test("returns undefined for gitlab when credentials are incomplete", () => {
    expect(defaultDevinternLabelOps("gitlab", {})).toBeUndefined();
    expect(defaultDevinternLabelOps("gitlab", { GITLAB_TOKEN: "tok" })).toBeUndefined();
    expect(defaultDevinternLabelOps("gitlab", { GITLAB_PROJECT: "acme/app" })).toBeUndefined();
  });

  test("gitlab: exists asks the encoded project labels endpoint", async () => {
    const calls = mockFetch(() => ({ json: { name: DEVINTERN_LABEL } }));
    const ops = defaultDevinternLabelOps("gitlab", GITLAB_ENV)!;

    await expect(ops.exists()).resolves.toBe(true);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain(
      `/projects/acme%2Fteam%2Fapp/labels/${DEVINTERN_LABEL}?include_ancestor_groups=true`,
    );
  });

  test("gitlab: create posts the devintern label options with a # color", async () => {
    const calls = mockFetch(() => ({ json: { name: DEVINTERN_LABEL } }));
    const ops = defaultDevinternLabelOps("gitlab", {
      ...GITLAB_ENV,
      GITLAB_BASE_URL: "https://gitlab.example.com/",
    })!;

    await ops.create();

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fteam%2Fapp/labels",
    );
    expect(calls[0].body).toMatchObject({
      name: DEVINTERN_LABEL,
      color: "#5319e7",
      description: expect.stringContaining("Ready for DevIntern"),
    });
  });
});
