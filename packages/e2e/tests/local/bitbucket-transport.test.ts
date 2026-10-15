import { expect, spyOn, test } from "bun:test";
import { Bitbucket } from "../../providers/bitbucket";

test("Bitbucket diff follows the API redirect and reads its text response", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "/2.0/repositories/workspace/fixture/diff/abc..def" },
      }),
    )
    .mockResolvedValueOnce(new Response("+export const greeting = 'Hello, world!';"));
  try {
    expect(await new Bitbucket("workspace/fixture", "test-token").diff(1)).toContain(
      "Hello, world!",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://api.bitbucket.org/2.0/repositories/workspace/fixture/diff/abc..def",
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("Bitbucket never follows a credential-bearing redirect to another host", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: "https://example.invalid/capture" } }),
  );
  try {
    await expect(new Bitbucket("workspace/fixture", "test-token").diff(1)).rejects.toThrow(
      "redirect destination",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Bitbucket PR discovery follows pages and preserves the exact source-branch filter", async () => {
  const base = "https://api.bitbucket.org/2.0/repositories/workspace/fixture";
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ values: [{ id: 1 }], next: `${base}/pullrequests?page=2` }),
    )
    .mockResolvedValueOnce(Response.json({ values: [{ id: 2 }] }));
  try {
    expect(
      await new Bitbucket("workspace/fixture", "test-token").pulls("feature/e2e-test"),
    ).toHaveLength(2);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe('source.branch.name="feature/e2e-test"');
    expect(url.searchParams.getAll("state")).toEqual(["OPEN", "MERGED", "DECLINED"]);
  } finally {
    fetchMock.mockRestore();
  }
});

test("Bitbucket rejects pagination links outside the configured repository", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ values: [], next: "https://example.invalid/page2" }),
  );
  try {
    await expect(
      new Bitbucket("workspace/fixture", "test-token").pulls("feature/e2e-test"),
    ).rejects.toThrow("pagination URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});
