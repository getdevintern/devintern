import { expect, spyOn, test } from "bun:test";
import { GitHub } from "../../providers/github";

const head = "feature/2";
const ownBase = "e2e/base-current";
const foreignBase = "e2e/base-previous";

/**
 * A stale closed PR a previous run on the shared code host left behind. GitHub
 * retains the PR for a deleted head ref, so it still matches `state=all&head=`.
 */
function stalePull(base: string) {
  return {
    number: 1,
    state: "closed",
    title: "[2] Expand the greeting",
    body: "",
    head: { ref: head, sha: "deadbeef" },
    base: { ref: base },
  };
}

function ownPull() {
  return {
    number: 2,
    state: "open",
    title: "[2] Expand the greeting",
    body: "",
    head: { ref: head, sha: "cafebabe" },
    base: { ref: ownBase },
  };
}

test("GitHub waitForPull selects this run's PR and ignores a stale head collision", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json([stalePull(foreignBase), ownPull()]),
  );
  try {
    const pull = await new GitHub("org/fixture", "token").waitForPull(head, ownBase);
    expect(pull.number).toBe(2);
    expect(pull.base.ref).toBe(ownBase);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("head")).toBe(`org:${head}`);
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub waitForPull still rejects an ambiguous head when no base scopes the lookup", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json([stalePull(foreignBase), ownPull()]),
  );
  try {
    await expect(new GitHub("org/fixture", "token").waitForPull(head)).rejects.toThrow(
      "Duplicate PRs for feature/2",
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub ensureLabel names the missing Issues permission when label creation is forbidden", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
  );
  try {
    await expect(
      new GitHub("org/fixture", "token").ensureLabel("devintern-authored"),
    ).rejects.toThrow("Creating labels requires Issues: write on the fixture repository");
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/repos/org/fixture/labels");
  } finally {
    fetchMock.mockRestore();
  }
});

test("GitHub ensureLabel tolerates an existing label and rethrows other failures", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json(
        {
          message: "Validation Failed",
          errors: [{ resource: "Label", code: "already_exists", field: "name" }],
        },
        { status: 422 },
      ),
    )
    .mockResolvedValueOnce(new Response("server error", { status: 500 }));
  try {
    const github = new GitHub("org/fixture", "token");
    await github.ensureLabel("devintern-authored");
    await expect(github.ensureLabel("devintern-authored")).rejects.toThrow("HTTP 500");
  } finally {
    fetchMock.mockRestore();
  }
});
