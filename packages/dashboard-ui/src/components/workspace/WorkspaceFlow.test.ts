import { expect, test } from "bun:test";

import { focusFromElement, placeRepoTop } from "@/components/workspace/WorkspaceFlow";
import { sortReposByOrder } from "@/components/workspace/WorkspaceSections";

/** A stub element whose `closest` resolves attributes by selector. */
function stub(attrs: Record<string, string>) {
  return {
    closest: (selector: string) => {
      const name = selector.slice(1, -1);
      return name in attrs ? { getAttribute: () => attrs[name] ?? null } : null;
    },
  };
}

test("focusFromElement restores the trace of the focused source or repo", () => {
  expect(focusFromElement(stub({ "data-source-node": "team:jira-default" }))).toEqual({
    source: "team:jira-default",
  });
  expect(focusFromElement(stub({ "data-repo-node": "x-rep" }))).toEqual({ repo: "x-rep" });
  expect(focusFromElement(stub({}))).toBeNull();
  expect(focusFromElement(null)).toBeNull();
});

test("placeRepoTop snaps small drifts to the even gap and keeps large ones", () => {
  expect(placeRepoTop(100, 90, 60)).toBe(100);
  expect(placeRepoTop(100, 124, 60)).toBe(100);
  expect(placeRepoTop(100, 400, 60)).toBe(160);
});

test("sortReposByOrder follows the diagram, unrouted repos last", () => {
  const repos = [{ name: "idle" }, { name: "b" }, { name: "a" }];
  expect(sortReposByOrder(repos, ["a", "b"]).map((repo) => repo.name)).toEqual(["a", "b", "idle"]);
});
